use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex};

use tonic::{transport::Server, Request, Response, Status};

pub mod engine {
    tonic::include_proto!("engine.v1");
}

use engine::engine_server::{Engine, EngineServer};
use engine::{
    GetTopOfBookRequest, GetTopOfBookResponse, HealthRequest, HealthResponse, Side,
    SubmitOrderRequest, SubmitOrderResponse,
};

#[derive(Debug, Default, Clone)]
struct OrderBook {
    // price -> total qty at that price
    bids: BTreeMap<i64, u64>, // best bid = last_key_value()
    asks: BTreeMap<i64, u64>, // best ask = first_key_value()
}

impl OrderBook {
    fn add_bid(&mut self, price: i64, qty: u64) {
        let e = self.bids.entry(price).or_insert(0);
        *e = e.saturating_add(qty);
    }

    fn add_ask(&mut self, price: i64, qty: u64) {
        let e = self.asks.entry(price).or_insert(0);
        *e = e.saturating_add(qty);
    }

    fn top_of_book(&self) -> (i64, i64, i64, i64) {
        // Return zeros when empty (matches your existing behavior)
        let (bid_p, bid_q) = match self.bids.last_key_value() {
            Some((p, q)) => (*p, (*q).min(i64::MAX as u64) as i64),
            None => (0, 0),
        };
        let (ask_p, ask_q) = match self.asks.first_key_value() {
            Some((p, q)) => (*p, (*q).min(i64::MAX as u64) as i64),
            None => (0, 0),
        };
        (bid_p, bid_q, ask_p, ask_q)
    }
}

#[derive(Debug, Default)]
struct EngineState {
    seq: u64,
    // symbol -> full price-level book
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

        let accepted_seq = self.with_state(|st| {
            let seq = Self::next_seq(st);

            // Get/create book for symbol
            let book = st.books.entry(symbol).or_default();

            // NOTE: still no matching. We just aggregate qty at price levels.
            let qty_u = o.qty as u64;
            let price_i = o.price;

            if o.side == Side::Buy as i32 {
                book.add_bid(price_i, qty_u);
            } else if o.side == Side::Sell as i32 {
                book.add_ask(price_i, qty_u);
            }

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
