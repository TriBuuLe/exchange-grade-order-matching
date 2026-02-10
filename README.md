# Exchange-Grade Order Book & Matching Engine

## Project Description

This project implements the **core infrastructure of a financial exchange** — the system responsible for accepting orders, maintaining market state, persisting data, and producing deterministic market outputs.

This is **not a trading bot** and **not a toy simulation**.  
It focuses on **correctness, determinism, durability, and clean system design**, similar to how real stock or crypto exchanges are built internally.

The system is split into three services:

- **Engine (Rust, gRPC)**  
  The authoritative core of the exchange. It validates orders, assigns deterministic sequence numbers, maintains a price-time priority order book, performs matching, and persists state.  
  It exposes only gRPC APIs and contains **no HTTP or UI logic**.

- **Gateway (Node.js, REST)**  
  A browser-friendly REST service that calls the engine via gRPC. It decouples the UI from the core engine and exposes market data, order entry, and a trade tape.

- **UI (Next.js)**  
  A browser-based frontend that visualizes live market data. It communicates only with the gateway and never directly with the engine.

This separation is intentional and mirrors real-world exchange architecture where the matching engine is isolated and authoritative.

---

## Current Capabilities

### Engine
- order submission with validation
- deterministic global sequence numbers
- full in-memory price-time priority order book (FIFO per price level)
- order matching with explicit fill records
- write-ahead logging (WAL) for durability
- snapshotting on clean shutdown
- deterministic state recovery on restart (snapshot + WAL replay)
- gRPC APIs for health, order entry, top-of-book, and depth

### Gateway
- REST → gRPC translation layer
- `/orders` for order submission
- `/tob` for top-of-book
- `/depth` for L2 depth
- `/events` trade tape (order accepted + fills)
- `/health` service health checks

### UI
- live top-of-book display
- L2 depth view
- order entry (BUY / SELL)
- fill feedback per submission
- trade tape showing accepted orders and fills
- polling-based updates (WebSockets planned)

---

## How to Set Up and Run Locally

## Running the System (Docker)

The entire exchange stack is fully containerized.  
**No manual setup is required beyond Docker.**

### Prerequisites
- Window Subsystem for Linux (WSL)
- Docker
- Docker Compose (included with Docker Desktop)

### Quick Start

```bash
git clone https://github.com/TriBuuLe/exchange-grade-order-matching.git
cd exchange-grade-order-matching
docker-compose up --build
```
Go to http://localhost:3000/ for live demo

## Reset The Market
```bash
cd exchange-grade-order-matching
rm -f services/engine/engine/data/snapshot.json services/engine/engine/data/wal.jsonl
docker-compose up --build
```

## Trading Bots
```bash
cd exchange-grade-order-matching
./auto-trade
```
Open more terminal and run the same script if you want to simulate concurrent trading.
