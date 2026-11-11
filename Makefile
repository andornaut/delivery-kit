.DEFAULT_GOAL := check

NODE_IMAGE := node:$(shell sed 's/^v//' .nvmrc)
SHELLCHECK_IMAGE := koalaman/shellcheck:v0.11.0
CHECK_MEMORY ?= 4g

# The checkout is bound read-only; the Node checks run in a tmpfs copy without Git metadata,
# dependencies or build output, with four CPUs and the host user's identity.
USER_ID := $(shell id -u)
GROUP_ID := $(shell id -g)
DOCKER_RUN := docker run --rm --cpus 4 --memory $(CHECK_MEMORY) --pids-limit 512 \
	--user $(USER_ID):$(GROUP_ID) --read-only --cap-drop ALL --security-opt no-new-privileges \
	--mount type=bind,src=$(CURDIR),dst=/source,readonly \
	--tmpfs /work:exec,size=3g,uid=$(USER_ID),gid=$(GROUP_ID) \
	--tmpfs /tmp:exec,size=1g,mode=1777 --env HOME=/tmp
NODE_RUN = $(DOCKER_RUN) --workdir /work $(NODE_IMAGE) sh -ec '\
	tar -C /source --exclude=./.git --exclude=node_modules --exclude=./dist \
		--exclude=./.worktrees --exclude=./.claude -cf - . | tar -xf -; \
	npm ci --ignore-scripts --no-audit --no-fund; \
	npm --prefix tests/contract ci --ignore-scripts --no-audit --no-fund; \
	$(1)'
SHELLCHECK_RUN := $(DOCKER_RUN) --network none --workdir /source $(SHELLCHECK_IMAGE) \
	-x -P SCRIPTDIR scripts/check.sh scripts/pack.sh tests/contract/run.sh

LINT := npm run check && npm run lint:node && npm run lint:markdown
TEST := npm run build && npm test && npm run contract
BUILD := npm run build && npm run package:check

.PHONY: check lint test build
check:
	$(call NODE_RUN,$(LINT) && $(TEST) && npm run package:check)
	$(SHELLCHECK_RUN)
lint:
	$(call NODE_RUN,$(LINT))
	$(SHELLCHECK_RUN)
test:
	$(call NODE_RUN,$(TEST))
build:
	$(call NODE_RUN,$(BUILD))
