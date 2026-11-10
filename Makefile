.DEFAULT_GOAL := check

CHECK_TASKS := lint test build
BUILD_OUTPUTS := .claude/release-output
CONTAINER_BUILD_ARGS := NODE_VERSION=$(shell sed 's/^v//' .nvmrc)
CHECK_TIMEOUT_SECONDS ?= 1800

override COMMAND := $(value COMMAND)
override TEST_ARGS := $(value TEST_ARGS)

export CHECK_TASKS BUILD_OUTPUTS CONTAINER_BUILD_ARGS TEST_ARGS COMMAND
export CHECK_TIMEOUT_SECONDS CHECK_SCRATCH_SIZE CHECK_WORK_SIZE CHECK_TMP_SIZE CHECK_NETWORK_LINT CONTAINER_IMAGE

.PHONY: check check-info lint test build exec

ifeq ($(INNER),1)
check lint test build exec:
	@/opt/check/run $@
else
check lint test build exec:
	@./tests/container/run $@
endif

check-info:
	@./tests/container/run info
