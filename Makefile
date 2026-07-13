# Dev is native, prod is docker (run everything in /srv/apps/pkos)
.PHONY: dev test deploy logs

dev:
	pnpm dev

test:
	pnpm test

deploy:
	git pull
	pnpm install --frozen-lockfile
	docker compose up -d --build
	@echo "deployed — API: pkos-api on :3002 (tailscale-only), ollama: pkos-ollama"

logs:
	docker logs -f --tail 100 pkos-api
