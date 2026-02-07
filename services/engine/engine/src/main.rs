mod order_book;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use order_book::{Order, OrderBook, Side as BookSide};

use tonic::{transport::Server, Request, Response, Status};

pub mod engine {
    tonic::include_proto!("engine.v1");
}

use engine::engine_server::{Engine, EngineServer};
use engine::{
    GetBookDepthRequest, GetBookDepthResponse, GetTopOfBookRequest, GetTopOfBookResponse,
    HealthRequest, HealthResponse, PriceLevel, Side, SubmitOrderRequest, SubmitOrderResponse,
};

#[derive(Debug, Default)]
struct EngineState {
    seq: u64,
    // symbol -> full price-level book (real FIFO order book)
    books: HashMap<String, OrderBook>,
}

#[derive(Clone)]
struct EngineSvc {
    state: Arc<Mutex<EngineState>>,
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

        let accepted_seq = self.with_state(|st| {
            let seq = Self::next_seq(st);

            let side = if o.side == Side::Buy as i32 {
                BookSide::Buy
            } else {
                BookSide::Sell
            };

            // Get/create book for symbol
            let book = st.books.entry(symbol).or_insert_with(OrderBook::new);

            // v1: NO MATCHING. We just rest orders into FIFO price levels.
            book.add(Order {
                seq,
                side,
                price: o.price,
                qty: o.qty,
                client_order_id,
            });

            seq
        });

        Ok(Response::new(SubmitOrderResponse { accepted_seq }))
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

            // bids: best -> worse (highest -> lower)
            let bids_out: Vec<PriceLevel> = book
                .bids
                .iter()
                .rev()
                .take(levels)
                .map(|(price, q)| PriceLevel {
                    price: *price,
                    qty: q.iter().map(|o| o.qty).sum::<i64>(),
                })
                .collect();

            // asks: best -> worse (lowest -> higher)
            let asks_out: Vec<PriceLevel> = book
                .asks
                .iter()
                .take(levels)
                .map(|(price, q)| PriceLevel {
                    price: *price,
                    qty: q.iter().map(|o| o.qty).sum::<i64>(),
                })
                .collect();

            (bids_out, asks_out)
        });

        Ok(Response::new(GetBookDepthResponse { bids, asks }))
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let addr = "0.0.0.0:50051".parse()?;
    let svc = EngineSvc {
        state: Arc::new(Mutex::new(EngineState::default())),
    };

    println!("engine listening on {}", addr);

    Server::builder()
        .add_service(EngineServer::new(svc))
        .serve(addr)
        .await?;

    Ok(())
}
