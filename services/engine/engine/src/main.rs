use std::collections::HashMap;
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

#[derive(Default)]
struct EngineState {
    seq: u64,
    // symbol -> (best_bid_price, best_bid_qty, best_ask_price, best_ask_qty)
    tob: HashMap<String, (i64, i64, i64, i64)>,
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

        // Minimal validation (still no matching)
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
            // assign seq
            let seq = Self::next_seq(st);

            // update top-of-book (toy version, not full book)
            let entry = st
                .tob
                .entry(symbol)
                .or_insert((0, 0, 0, 0)); // (bidP, bidQ, askP, askQ)

            if o.side == Side::Buy as i32 {
                let (bid_p, _bid_q, ask_p, ask_q) = *entry;
                if bid_p == 0 || o.price > bid_p {
                    *entry = (o.price, o.qty, ask_p, ask_q);
                }
            } else if o.side == Side::Sell as i32 {
                let (bid_p, bid_q, ask_p, _ask_q) = *entry;
                if ask_p == 0 || o.price < ask_p {
                    *entry = (bid_p, bid_q, o.price, o.qty);
                }
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
            st.tob.get(&symbol).copied().unwrap_or((0, 0, 0, 0))
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
