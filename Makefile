SHELL := /bin/bash
SERVICE ?= all
V ?= 0
BACKUP ?=
PROJECT ?=
FORCE ?= 0

VOLUME_PROJECT_FLAG = $(if $(strip $(PROJECT)),--project-name "$(PROJECT)",)
VOLUME_FORCE_FLAG = $(if $(filter 1 true yes,$(FORCE)),--force,)

.PHONY: help dev install install-backend install-frontend lint lint-backend lint-frontend test test-backend test-frontend reindex backup backups restore

help:
	@./scripts/help.sh

dev:
	@./scripts/dev.sh $(SERVICE) $(if $(filter 1 true yes,$(V)),-v,)

install:
	@./scripts/install.sh $(SERVICE) $(if $(filter 1 true yes,$(V)),-v,)

install-backend:
	@./scripts/install.sh backend $(if $(filter 1 true yes,$(V)),-v,)

install-frontend:
	@./scripts/install.sh frontend $(if $(filter 1 true yes,$(V)),-v,)

lint:
	@./scripts/lint.sh $(SERVICE) $(if $(filter 1 true yes,$(V)),-v,)

lint-backend:
	@./scripts/lint.sh backend $(if $(filter 1 true yes,$(V)),-v,)

lint-frontend:
	@./scripts/lint.sh frontend $(if $(filter 1 true yes,$(V)),-v,)

test:
	@./scripts/test.sh $(SERVICE) $(if $(filter 1 true yes,$(V)),-v,)

test-backend:
	@./scripts/test.sh backend $(if $(filter 1 true yes,$(V)),-v,)

test-frontend:
	@./scripts/test.sh frontend $(if $(filter 1 true yes,$(V)),-v,)

reindex:
	@./scripts/reindex.sh $(if $(filter 1 true yes,$(V)),-v,)

backup:
	@./scripts/docker-volumes.sh backup $(VOLUME_PROJECT_FLAG)

backups:
	@./scripts/docker-volumes.sh list

restore:
	@if [[ -z "$(strip $(BACKUP))" ]]; then \
		printf 'Usage: make restore BACKUP=<backup-directory> [PROJECT=<name>] [FORCE=1]\n' >&2; \
		exit 1; \
	fi
	@./scripts/docker-volumes.sh restore "$(BACKUP)" $(VOLUME_PROJECT_FLAG) $(VOLUME_FORCE_FLAG)
