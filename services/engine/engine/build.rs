fn main() {
    tonic_build::configure()
        .build_server(true)
        .compile(
            &["../../../proto/engine.proto"],
            &["../../../proto"],
        )
        .unwrap();
}
