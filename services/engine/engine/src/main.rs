use std::sync::{Arc, Mutex};

use tonic::{transport::Server, Request, Response, Status};

pub mod engine {
    tonic::include_proto!("engine.v1");
}

use engine::engine_server::{Engine, EngineServer};
use engine::{HealthRequest, HealthResponse, Side, SubmitOrderRequest, SubmitOrderResponse};

#[derive(Default)]
struct EngineState {
    seq: u64,
}

#[derive(Clone)]
struct EngineSvc {
    state: Arc<Mutex<EngineState>>,
}

impl EngineSvc {
    fn next_seq(&self) -> u64 {
        let mut st = self.state.lock().expect("engine state mutex poisoned");
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

        // Minimal validation (no book, no matching yet)
        if o.symbol.trim().is_empty() {
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

        let seq = self.next_seq();

        Ok(Response::new(SubmitOrderResponse { accepted_seq: seq }))
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
