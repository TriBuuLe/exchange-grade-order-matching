.PHONY: engine gateway ui dev

engine:
	cd services/engine/engine && cargo run

gateway:
	cd services/gateway && npm run dev

ui:
	cd services/ui && npm run dev

dev:
	@echo "Run these in separate terminals:"
	@echo "make engine"
	@echo "make gateway"
	@echo "make ui"
