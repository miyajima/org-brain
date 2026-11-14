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
    let feature_set = args.len() == 3 && args[1] == "--feature-set";
    anyhow::ensure!(
        feature_set || args.len() == 4,
        "expected root, features file and epoch, or --feature-set <absolute-config>"
    );
    let mut input = String::new();
    io::stdin().take(16_000_001).read_to_string(&mut input)?;
    anyhow::ensure!(input.len() <= 16_000_000, "request_too_large");
    let input = serde_json::from_str(&input)?;
    if feature_set {
        return orgbrain_wiki_engine::set_feature(&PathBuf::from(&args[2]), &input);
    }
    orgbrain_wiki_engine::execute(
        &PathBuf::from(&args[1]),
        &PathBuf::from(&args[2]),
        args[3].parse().context("invalid epoch")?,
        &input,
    )
}
