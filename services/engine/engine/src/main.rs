// services/engine/engine/src/main.rs

mod order_book;
mod wal;

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};

use order_book::{Order, OrderBook, Side as BookSide};
use wal::{Wal, WalEntry};

use tonic::{transport::Server, Request, Response, Status};

pub mod engine {
    tonic::include_proto!("engine.v1");
}

use engine::engine_server::{Engine, EngineServer};
use engine::{
    Fill, GetBookDepthRequest, GetBookDepthResponse, GetRecentTradesRequest, GetRecentTradesResponse,
    GetTopOfBookRequest, GetTopOfBookResponse, HealthRequest, HealthResponse, PriceLevel, Side,
    SubmitOrderRequest, SubmitOrderResponse, Trade,
};

const MAX_TRADES_PER_SYMBOL: usize = 10_000;
const MAX_TRADES_LIMIT: usize = 1_000;

#[derive(Debug)]
pub struct EngineState {
    pub seq: u64,
    // symbol -> full price-level book (real FIFO order book)
    pub books: HashMap<String, OrderBook>,

    // Trade tape (pull-based). Per symbol ring buffer of recent trades.
    pub next_trade_id: u64,
    pub trades: HashMap<String, VecDeque<Trade>>,
}

impl Default for EngineState {
    fn default() -> Self {
        Self {
            seq: 0,
            books: HashMap::new(),
            next_trade_id: 0,
            trades: HashMap::new(),
        }
    }
}

#[derive(Clone)]
struct EngineSvc {
    state: Arc<Mutex<EngineState>>,
    wal: Wal,
}

impl EngineSvc {
    fn with_state<F, R>(&self, f: F) -> R
    where
        F: FnOnce(&mut EngineState) -> R,
    {
        let mut st = self.state.lock().expect("engine state mutex poisoned");
        f(&mut st)
    }

    fn next_seq(st: &mut EngineState) -> u64 {
        st.seq += 1;
        st.seq
    }

    fn next_trade_id(st: &mut EngineState) -> u64 {
        st.next_trade_id += 1;
        st.next_trade_id
    }

    fn append_trade(st: &mut EngineState, symbol: &str, trade: Trade) {
        let q = st
            .trades
            .entry(symbol.to_string())
            .or_insert_with(VecDeque::new);
        q.push_back(trade);

        // Bounded memory
        while q.len() > MAX_TRADES_PER_SYMBOL {
            q.pop_front();
        }
    }
}

fn env_or_default(key: &str, default: &str) -> String {
    std::env::var(key)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| default.to_string())
}

#[tonic::async_trait]
impl Engine for EngineSvc {
    async fn health(
        &self,
        _req: Request<HealthRequest>,
    ) -> Result<Response<HealthResponse>, Status> {
        Ok(Response::new(HealthResponse {
            status: "ok".to_string(),
        }))
    }

    async fn submit_order(
        &self,
        req: Request<SubmitOrderRequest>,
    ) -> Result<Response<SubmitOrderResponse>, Status> {
        let o = req.into_inner();

        // Validation
        let symbol = o.symbol.trim().to_string();
        if symbol.is_empty() {
            return Err(Status::invalid_argument("symbol must be non-empty"));
        }
        if o.qty <= 0 {
            return Err(Status::invalid_argument("qty must be > 0"));
        }
        if o.price < 0 {
            return Err(Status::invalid_argument("price must be >= 0"));
        }
        if o.side == Side::Unspecified as i32 {
            return Err(Status::invalid_argument("side must be BUY or SELL"));
        }

        let client_order_id = o.client_order_id.trim().to_string();

        // Single-writer mutex: append WAL then mutate memory.
        let (accepted_seq, fills_out) = self.with_state(|st| {
            let seq = Self::next_seq(st);

            let side_str = if o.side == Side::Buy as i32 { "BUY" } else { "SELL" };

            // 1) Append WAL entry FIRST (durability boundary for "accepted")
            let entry = WalEntry {
                seq,
                symbol: symbol.clone(),
                side: side_str.to_string(),
                price: o.price,
                qty: o.qty,
                client_order_id: client_order_id.clone(),
            };

            if let Err(e) = self.wal.append(&entry) {
                // Roll back seq so sequence stays gap-free if WAL write fails
                st.seq -= 1;
                return Err(Status::unavailable(format!("WAL append failed: {e}")));
            }

            // 2) Apply to in-memory book (matching happens here)
            let side = if o.side == Side::Buy as i32 {
                BookSide::Buy
            } else {
                BookSide::Sell
            };

            let book = st.books.entry(symbol.clone()).or_insert_with(OrderBook::new);

            let fills = book.add(Order {
                seq,
                side,
                price: o.price,
                qty: o.qty,
                client_order_id: client_order_id.clone(),
            });

            // Map internal fills to gRPC fills AND append trades to the tape.
            // Each Fill becomes one Trade. trade_id monotonic in engine state.
            let mut fills_out: Vec<Fill> = Vec::with_capacity(fills.len());

            for f in fills.into_iter() {
                fills_out.push(Fill {
                    maker_seq: f.maker_seq,
                    taker_seq: f.taker_seq,
                    price: f.price,
                    qty: f.qty,
                });

                let trade_id = Self::next_trade_id(st);

                // taker_side: the incoming order's side
                let taker_side = if o.side == Side::Buy as i32 {
                    Side::Buy
                } else {
                    Side::Sell
                };

                let trade = Trade {
                    trade_id,
                    symbol: symbol.clone(),
                    price: f.price,
                    qty: f.qty,
                    maker_seq: f.maker_seq,
                    taker_seq: f.taker_seq,
                    taker_side: taker_side as i32,
                };

                Self::append_trade(st, &symbol, trade);
            }

            Ok((seq, fills_out))
        })?;

        Ok(Response::new(SubmitOrderResponse {
            accepted_seq,
            fills: fills_out,
        }))
    }

    async fn get_top_of_book(
        &self,
        req: Request<GetTopOfBookRequest>,
    ) -> Result<Response<GetTopOfBookResponse>, Status> {
        let symbol = req.into_inner().symbol.trim().to_string();
        if symbol.is_empty() {
            return Err(Status::invalid_argument("symbol must be non-empty"));
        }

        let (bid_p, bid_q, ask_p, ask_q) = self.with_state(|st| {
            st.books
                .get(&symbol)
                .map(|b| b.top_of_book())
                .unwrap_or((0, 0, 0, 0))
        });

        Ok(Response::new(GetTopOfBookResponse {
            best_bid_price: bid_p,
            best_bid_qty: bid_q,
            best_ask_price: ask_p,
            best_ask_qty: ask_q,
        }))
    }

    async fn get_book_depth(
        &self,
        req: Request<GetBookDepthRequest>,
    ) -> Result<Response<GetBookDepthResponse>, Status> {
        let r = req.into_inner();
        let symbol = r.symbol.trim().to_string();
        if symbol.is_empty() {
            return Err(Status::invalid_argument("symbol must be non-empty"));
        }

        // default: 10 levels if not provided or invalid
        let mut levels: usize = if r.levels <= 0 { 10 } else { r.levels as usize };
        if levels > 100 {
            levels = 100; // hard cap to keep response bounded
        }

        let (bids, asks) = self.with_state(|st| {
            let book = match st.books.get(&symbol) {
                Some(b) => b,
                None => return (Vec::new(), Vec::new()),
            };

            let bids_out: Vec<PriceLevel> = book
                .bids
                .iter()
                .rev()
                .take(levels)
                .map(|(price, q)| PriceLevel {
                    price: *price,
                    qty: q.iter().map(|o| o.remaining_qty).sum::<i64>(),
                })
                .collect();

            let asks_out: Vec<PriceLevel> = book
                .asks
                .iter()
                .take(levels)
                .map(|(price, q)| PriceLevel {
                    price: *price,
                    qty: q.iter().map(|o| o.remaining_qty).sum::<i64>(),
                })
                .collect();

            (bids_out, asks_out)
        });

        Ok(Response::new(GetBookDepthResponse { bids, asks }))
    }

    async fn get_recent_trades(
        &self,
        req: Request<GetRecentTradesRequest>,
    ) -> Result<Response<GetRecentTradesResponse>, Status> {
        let r = req.into_inner();
        let symbol = r.symbol.trim().to_string();
        if symbol.is_empty() {
            return Err(Status::invalid_argument("symbol must be non-empty"));
        }

        let after_trade_id = r.after_trade_id;
        let mut limit: usize = if r.limit <= 0 { 50 } else { r.limit as usize };
        if limit > MAX_TRADES_LIMIT {
            limit = MAX_TRADES_LIMIT;
        }

        let (trades, last_trade_id) = self.with_state(|st| {
            let q = match st.trades.get(&symbol) {
                Some(q) => q,
                None => return (Vec::new(), after_trade_id),
            };

            // trades are stored in ascending trade_id order
            let mut out: Vec<Trade> = Vec::new();
            out.reserve(limit);

            for t in q.iter() {
                if t.trade_id > after_trade_id {
                    out.push(t.clone());
                    if out.len() >= limit {
                        break;
                    }
                }
            }

            let last = out
                .last()
                .map(|t| t.trade_id)
                .unwrap_or(after_trade_id);

            (out, last)
        });

        Ok(Response::new(GetRecentTradesResponse {
            trades,
            last_trade_id,
        }))
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Default WAL path under engine crate:
    // services/engine/engine/data/wal.jsonl
    let wal_path = env_or_default("ENGINE_WAL_PATH", "data/wal.jsonl");
    let wal = Wal::new(&wal_path);

    // ---- startup debug (prove we're reading the file we think we are) ----
    let cwd = std::env::current_dir().ok();
    println!("[startup] cwd = {:?}", cwd);

    let wal_abs = cwd
        .as_ref()
        .map(|d| d.join(&wal_path))
        .unwrap_or_else(|| std::path::PathBuf::from(&wal_path));
    println!("[startup] wal_path (cfg) = {}", wal_path);
    println!("[startup] wal_path (abs) = {:?}", wal_abs);

    match std::fs::metadata(wal.wal_path()) {
        Ok(m) => println!("[startup] wal metadata: exists=true size={} bytes", m.len()),
        Err(e) => println!("[startup] wal metadata: exists=false err={}", e),
    }

    match std::fs::metadata(wal.snapshot_path()) {
        Ok(m) => println!(
            "[startup] snapshot metadata: exists=true size={} bytes",
            m.len()
        ),
        Err(e) => println!("[startup] snapshot metadata: exists=false err={}", e),
    }
    // ---------------------------------------------------------------

    // Create state, then replay snapshot + WAL into it BEFORE serving.
    let mut st = EngineState::default();

    match wal.replay_into_with_stats(&mut st) {
        Ok(stats) => {
            if stats.snapshot_present {
                println!(
                    "[snapshot] loaded seq={} books={} orders={} from {}",
                    stats.snapshot_seq,
                    stats.snapshot_books,
                    stats.snapshot_orders,
                    wal.snapshot_path().display()
                );
            } else {
                println!("[snapshot] none present (cold start)");
            }

            println!(
                "[wal] replayed {} entries after snapshot_seq={} from {}",
                stats.wal_replayed,
                stats.wal_after_seq,
                wal.wal_path().display()
            );
        }
        Err(e) => {
            // Hard fail: if WAL/snapshot is corrupt, we should not serve incorrect state.
            eprintln!(
                "[startup] restore failed (snapshot={}, wal={}): {}",
                wal.snapshot_path().display(),
                wal.wal_path().display(),
                e
            );
            return Err(e.into());
        }
    }

    let svc = EngineSvc {
        state: Arc::new(Mutex::new(st)),
        wal,
    };

    let addr = "0.0.0.0:50051".parse()?;
    println!("engine listening on {}", addr);

    let state_for_shutdown = svc.state.clone();
    let wal_for_shutdown = svc.wal.clone();

    Server::builder()
        .add_service(EngineServer::new(svc))
        .serve_with_shutdown(addr, async move {
            // waits for Ctrl+C
            let _ = tokio::signal::ctrl_c().await;

            // best-effort snapshot on clean shutdown
            if let Ok(st) = state_for_shutdown.lock() {
                if let Err(e) = wal_for_shutdown.write_snapshot(&st) {
                    eprintln!("[snapshot] write failed: {e}");
                } else {
                    println!("[snapshot] wrote snapshot OK");

                    if let Err(e) = wal_for_shutdown.truncate_wal() {
                        eprintln!("[wal] truncate failed: {e}");
                    } else {
                        println!("[wal] truncated");
                    }
                }
            } else {
                eprintln!("[snapshot] state mutex poisoned; snapshot skipped");
            }
        })
        .await?;

    Ok(())
}
