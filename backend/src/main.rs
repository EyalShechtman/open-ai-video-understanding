mod handlers;
mod routes;
mod services;

/// Main entry point for the backend server
#[tokio::main]
async fn main() {
    // Load environment variables from .env file
    dotenv::dotenv().ok();
    
    // Initialize tracing for logging
    tracing_subscriber::fmt::init();

    // Create and run the server on port 4000 (Next.js uses 3000)
    let app = routes::create_router();
    let addr: std::net::SocketAddr = "0.0.0.0:4000".parse().unwrap();

    println!("Server running on http://{}", addr);
    axum::serve(tokio::net::TcpListener::bind(addr).await.unwrap(), app)
        .await
        .unwrap();
}
