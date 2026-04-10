# Zelo AI Server Deploy Ready

This file is a ready reference for deploying `zelo_ai` on the existing Zelo server
behind Traefik, using the real Swissdata backend.

It does not change any existing project file.

## What is already confirmed

- Real Swissdata backend works for `zelo_ai` with:

```env
SWISSDATA_BASE_URL=https://api.zelo-epicerie.ch
SWISSDATA_API_KEY=PUBLICDEMO01
SWISSDATA_SHOP_ID=000000000000000000000001
```

- Existing server / proxy setup already uses Traefik and host-based routing for:
  - `api.zelo-epicerie.ch`
  - `app.zelo-epicerie.ch`
  - `config.zelo-epicerie.ch`
  - `map.zelo-epicerie.ch`

- Existing server SSH:
  - host: `195.15.215.113`
  - port: `5222`

## Important current limitation

Today `src/ai/agent.ts` always calls Ollama directly.
So for server deploy you need one of these:

1. Recommended:
   run Ollama on the server too

2. Temporary:
   expose your local Ollama publicly / privately and point `OLLAMA_BASE_URL` to it

For a real deploy, option 1 is the right one.

## Recommended target URL

Use:

```text
ai.zelo-epicerie.ch
```

You will need DNS to point this hostname to the same server as the other Zelo hosts.

## Suggested server folder

Follow the same pattern as the existing deployment folders:

```text
~/Git/zelo_ai
~/zelo-ai
```

Example:

```text
/home/ubuntu/Git/zelo_ai
/home/ubuntu/zelo-ai
```

## Suggested `.env` for server deploy

Create a dedicated deploy env such as:

```env
NODE_ENV=production
PORT=3041

AI_PROVIDER=ollama
OLLAMA_BASE_URL=http://ollama:11434
OLLAMA_MODEL=llama3.2
OLLAMA_PLANNER_MODEL=llama3.2:1b

SWISSDATA_BASE_URL=https://api.zelo-epicerie.ch
SWISSDATA_API_KEY=PUBLICDEMO01
SWISSDATA_SHOP_ID=000000000000000000000001
SWISSDATA_COUNTRY=CHE

META_VERIFY_TOKEN=
META_APP_SECRET=
META_GRAPH_TOKEN=

OPENAI_API_KEY=

PROXYNET=traefik-net
```

If you temporarily keep Ollama on your own machine, replace:

```env
OLLAMA_BASE_URL=http://ollama:11434
```

with the reachable URL of your exposed Ollama endpoint.

## Suggested server compose

This is the compose I would use as the base for `ai.zelo-epicerie.ch`.

```yaml
version: "3.1"

services:
  ollama:
    image: ollama/ollama:latest
    container_name: zelo-ai-ollama
    restart: unless-stopped
    volumes:
      - /home/ubuntu/zelo-ai/ollama:/root/.ollama
    networks:
      - ai
    environment:
      - OLLAMA_HOST=0.0.0.0
      - OLLAMA_KEEP_ALIVE=30m

  zelo_ai:
    build:
      context: /home/ubuntu/Git/zelo_ai
      dockerfile: Dockerfile.dev
    container_name: zelo-ai-web
    restart: unless-stopped
    depends_on:
      - ollama
    env_file:
      - .env
    command: ["npm", "run", "dev"]
    volumes:
      - /home/ubuntu/Git/zelo_ai:/app
      - /app/node_modules
    networks:
      - ai
      - proxy
    labels:
      - "traefik.enable=true"
      - "traefik.docker.network=${PROXYNET}"
      - "traefik.http.routers.zelo-ai-http.entrypoints=http"
      - "traefik.http.routers.zelo-ai-http.rule=Host(`ai.zelo-epicerie.ch`)"
      - "traefik.http.routers.zelo-ai-http.middlewares=zelo-ai-https"
      - "traefik.http.middlewares.zelo-ai-https.redirectscheme.scheme=https"
      - "traefik.http.routers.zelo-ai.entrypoints=https"
      - "traefik.http.routers.zelo-ai.rule=Host(`ai.zelo-epicerie.ch`)"
      - "traefik.http.routers.zelo-ai.tls=true"
      - "traefik.http.routers.zelo-ai.tls.certresolver=p5"
      - "traefik.http.services.zelo-ai.loadbalancer.server.port=3041"

networks:
  proxy:
    name: ${PROXYNET}
    external: true
  ai:
```

## DNS / Traefik checklist

1. Create DNS record:
   - `ai.zelo-epicerie.ch`
   - same server IP as the other Zelo subdomains

2. Deploy the new compose on the same host as Traefik

3. Ensure the service joins:
   - `traefik-net`

4. Let Traefik issue TLS using:
   - `certresolver=p5`

## Practical deploy sequence

1. Copy / clone repo on server:

```bash
ssh -p 5222 ubuntu@195.15.215.113
mkdir -p ~/Git
cd ~/Git
git clone <your-repo-url> zelo_ai
```

2. Create persistent folder:

```bash
mkdir -p ~/zelo-ai
mkdir -p ~/zelo-ai/ollama
```

3. Create the deploy folder, for example:

```bash
mkdir -p ~/zelo-ai/deploy
cd ~/zelo-ai/deploy
```

4. Put there:
   - `.env`
   - `docker-compose.yml`

5. Start:

```bash
docker compose --env-file .env up -d --build
```

6. Check:

```bash
docker ps
docker logs -f zelo-ai-web
docker logs -f zelo-ai-ollama
```

7. Test:
   - `https://ai.zelo-epicerie.ch`

## Things to fix before public multi-user rollout

These are not blockers for a first internal deploy test, but they matter before opening it to everyone.

1. `public/index.html` still uses a fixed `USER_REF = "local-dev"`
   - multiple users will collide

2. Swissdata auth/session storage is in RAM
   - restarting the container loses sessions

3. `npm run dev` uses nodemon
   - acceptable for a first internal test
   - not ideal for stable production

4. There is no dedicated production Dockerfile yet
   - current compose uses `Dockerfile.dev`

## Recommended first internal deploy order

1. Internal deploy on server with Ollama also on server
2. Verify:
   - login
   - basket view
   - add/remove
   - checkout
3. Only then:
   - unique `userRef` per browser
   - persistent session store
   - production Dockerfile / build
