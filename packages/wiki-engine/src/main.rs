use anyhow::{Context, Result};
use serde_json::json;
use std::{
    io::{self, Read},
    path::PathBuf,
};

fn main() {
    match run() {
        Ok(value) => println!("{value}"),
        Err(error) => {
            println!("{}", json!({"error": format!("{error:#}")}));
            std::process::exit(1);
        }
    }
}
fn run() -> Result<serde_json::Value> {
    let args: Vec<String> = std::env::args().collect();
    anyhow::ensure!(args.len() == 4, "expected root, features file and epoch");
    let mut input = String::new();
    io::stdin().take(16_000_001).read_to_string(&mut input)?;
    anyhow::ensure!(input.len() <= 16_000_000, "request_too_large");
    orgbrain_wiki_engine::execute(
        &PathBuf::from(&args[1]),
        &PathBuf::from(&args[2]),
        args[3].parse().context("invalid epoch")?,
        &serde_json::from_str(&input)?,
    )
}
