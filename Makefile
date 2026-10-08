.NOTPARALLEL:

NPM := npm

.PHONY: ci install format format-check lint check architecture test coverage security build package

ci: build format-check lint check architecture coverage package native-examples policy security secrets

install:
	$(NPM) ci --ignore-scripts
format:
	$(NPM) run format
format-check:
	$(NPM) run format:check
lint:
	$(NPM) run lint
check:
	$(NPM) run check
architecture:
	$(NPM) run architecture
test:
	$(NPM) test
coverage:
	$(NPM) run test:coverage
security:
	$(NPM) run security
build:
	$(NPM) run build
package:
	npm run test:package

policy:
	$(NPM) run policy
secrets:
	$(NPM) run secrets

PYTHON ?= python3
PYTHON_COMMAND := $(if $(findstring /,$(PYTHON)),$(abspath $(PYTHON)),$(PYTHON))
.PHONY: python-install python-ci python-format python-lint python-test python-package bot-frameworks strict-contract emulator-container
python-install:
	$(PYTHON_COMMAND) -m pip install -r requirements-quality.txt -r compatibility/aiogram/requirements.txt -e ./python/lo-aiogram -e ./python/lo-bot-api-emulator
python-ci: python-format python-lint python-test python-package python-security
python-format:
	$(PYTHON_COMMAND) -m ruff format --check python scripts/*.py compatibility/aiogram
python-lint:
	$(PYTHON_COMMAND) -m ruff check python scripts/*.py compatibility/aiogram
	$(PYTHON_COMMAND) -m mypy python/lo-aiogram/src python/lo-bot-api-emulator/src
python-test:
	$(PYTHON_COMMAND) -m coverage run -m unittest discover -s python/tests -v
	$(PYTHON_COMMAND) -m coverage report
	$(PYTHON_COMMAND) -m coverage xml
	cd compatibility/aiogram && $(PYTHON_COMMAND) -m unittest discover -v
python-package:
	rm -rf python/lo-aiogram/dist python/lo-bot-api-emulator/dist
	$(PYTHON_COMMAND) -m build python/lo-aiogram
	$(PYTHON_COMMAND) -m build python/lo-bot-api-emulator
	$(PYTHON_COMMAND) -m twine check python/lo-aiogram/dist/* python/lo-bot-api-emulator/dist/*
	$(PYTHON_COMMAND) scripts/check-python-packages.py
bot-frameworks:
	$(NPM) ci --ignore-scripts --prefix compatibility/bot-frameworks
	$(NPM) test --prefix compatibility/bot-frameworks
	$(NPM) audit --audit-level=high --prefix compatibility/bot-frameworks
strict-contract:
	LO_STRICT_PYTHON=$(PYTHON_COMMAND) $(NPM) run test:strict --prefix compatibility/bot-frameworks
emulator-container:
	docker build -t lo-bot-api-emulator:ci python/lo-bot-api-emulator
	$(PYTHON_COMMAND) scripts/check-emulator-container.py lo-bot-api-emulator:ci

aiogram:
	cd compatibility/aiogram && $(PYTHON_COMMAND) -m unittest discover -v
python-security:
	$(PYTHON_COMMAND) -m pip_audit --disable-pip --no-deps -r compatibility/aiogram/requirements.txt

.PHONY: release-check
release-check:
	node scripts/check-release-ci.mjs

.PHONY: native-examples
native-examples:
	$(NPM) ci --ignore-scripts --prefix compatibility/native-miniapp
	$(NPM) test --prefix compatibility/native-miniapp
	$(NPM) audit --audit-level=high --prefix compatibility/native-miniapp
