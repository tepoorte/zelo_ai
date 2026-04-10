# Remote Ollama Test

This is a zero-impact test path for running the planner against a separate Ollama server.

Nothing in the current app runtime needs to change:
- do not edit `.env`
- do not edit `docker-compose.zelo-ai.yml`
- do not stop the current local Ollama stack

## 1. Prepare any Ubuntu server

The cleanest test is an Ubuntu server that runs Ollama separately.

Install Ollama:

```bash
curl -fsSL https://ollama.com/install.sh | sh
```

Expose Ollama on the server itself and keep models warm:

```bash
sudo systemctl edit ollama
```

Paste:

```ini
[Service]
Environment="OLLAMA_HOST=0.0.0.0"
Environment="OLLAMA_KEEP_ALIVE=30m"
```

Then reload:

```bash
sudo systemctl daemon-reload
sudo systemctl restart ollama
sudo systemctl status ollama
```

Pull the same models used by the local app:

```bash
ollama pull llama3.2:1b
ollama pull llama3.2
ollama pull nomic-embed-text
```

Quick local sanity check on the server:

```bash
curl http://127.0.0.1:11434/api/tags
```

## 2. Reach the server without changing the app

Prefer an SSH tunnel instead of exposing Ollama publicly:

```bash
ssh -L 11435:127.0.0.1:11434 user@your-server
```

As long as that shell stays open, the remote Ollama API is reachable from your Mac at:

```text
http://localhost:11435
```

Quick test from your Mac:

```bash
curl http://localhost:11435/api/tags
```

## 3. Run the planner smoke test locally against the remote Ollama

From the project root:

```bash
cd /Users/samueltepoorten/Desktop/zelo_dev/zelo_ai
```

Run:

```bash
OLLAMA_BASE_URL=http://localhost:11435 \
OLLAMA_PLANNER_MODEL=llama3.2:1b \
node --loader ts-node/esm ./scripts/test-planner-remote.ts \
  local-dev \
  "Ajoute 1 lard de Begnins à mon panier"
```

What this does:
- leaves the running app untouched
- leaves the current `.env` untouched
- sends a one-off planner request to the remote Ollama
- prints elapsed time and the parsed plan

## 4. Compare with local

To compare remote vs local, run the same script twice with different base URLs.

Local:

```bash
OLLAMA_BASE_URL=http://localhost:11434 \
OLLAMA_PLANNER_MODEL=llama3.2:1b \
node --loader ts-node/esm ./scripts/test-planner-remote.ts \
  local-dev \
  "Ajoute 1 lard de Begnins à mon panier"
```

Remote:

```bash
OLLAMA_BASE_URL=http://localhost:11435 \
OLLAMA_PLANNER_MODEL=llama3.2:1b \
node --loader ts-node/esm ./scripts/test-planner-remote.ts \
  local-dev \
  "Ajoute 1 lard de Begnins à mon panier"
```

## Notes

- If you reuse the exact same `userRef` and message, the planner cache may make repeated tests look much faster.
- If you want a fresh measurement, change the `userRef`, for example `remote-test-1`, `remote-test-2`, etc.
- This path is intentionally separate from the app. Integration can happen later by changing only `OLLAMA_BASE_URL`.
