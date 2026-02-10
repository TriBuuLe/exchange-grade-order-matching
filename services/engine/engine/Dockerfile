FROM rust:1.82 as builder
WORKDIR /app

RUN apt-get update && apt-get install -y protobuf-compiler && rm -rf /var/lib/apt/lists/*

COPY services/engine/engine/Cargo.toml services/engine/engine/Cargo.lock ./
COPY services/engine/engine/build.rs ./
COPY services/engine/engine/src ./src

# put repo proto at /proto inside image
COPY proto /proto

# IMPORTANT: your build.rs currently says ../../../proto/engine.proto
# When building inside Docker, that path is WRONG.
# So we patch build.rs to use /proto/engine.proto.
RUN sed -i 's|\\.\\./\\.\\./\\.\\./proto|/proto|g' build.rs

RUN cargo build --release

FROM debian:bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app/target/release/engine /app/engine
EXPOSE 50051
CMD ["/app/engine"]
