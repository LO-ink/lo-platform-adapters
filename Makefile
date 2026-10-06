.NOTPARALLEL:

NPM := npm

.PHONY: ci install format format-check lint check architecture test coverage security build package

ci: build format-check lint check architecture coverage package policy security secrets

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
.PHONY: python-install python-ci python-format python-lint python-test python-package bot-frameworks strict-contract emulator-container
python-install:
	$(PYTHON) -m pip install -r requirements-quality.txt -r compatibility/aiogram/requirements.txt -e ./python/lo-aiogram -e ./python/lo-bot-api-emulator
python-ci: python-format python-lint python-test python-package python-security
python-format:
	$(PYTHON) -m ruff format --check python scripts/*.py compatibility/aiogram
python-lint:
	$(PYTHON) -m ruff check python scripts/*.py compatibility/aiogram
	$(PYTHON) -m mypy python/lo-aiogram/src python/lo-bot-api-emulator/src
python-test:
	$(PYTHON) -m coverage run -m unittest discover -s python/tests -v
	$(PYTHON) -m coverage report
	$(PYTHON) -m coverage xml
	cd compatibility/aiogram && $(PYTHON) -m unittest discover -v
python-package:
	rm -rf python/lo-aiogram/dist python/lo-bot-api-emulator/dist
	$(PYTHON) -m build python/lo-aiogram
	$(PYTHON) -m build python/lo-bot-api-emulator
	$(PYTHON) -m twine check python/lo-aiogram/dist/* python/lo-bot-api-emulator/dist/*
	$(PYTHON) scripts/check-python-packages.py
bot-frameworks:
	$(NPM) ci --ignore-scripts --prefix compatibility/bot-frameworks
	$(NPM) test --prefix compatibility/bot-frameworks
	$(NPM) audit --audit-level=high --prefix compatibility/bot-frameworks
strict-contract:
	LO_STRICT_PYTHON=$(PYTHON) $(NPM) run test:strict --prefix compatibility/bot-frameworks
emulator-container:
	docker build -t lo-bot-api-emulator:ci python/lo-bot-api-emulator
	$(PYTHON) scripts/check-emulator-container.py lo-bot-api-emulator:ci

aiogram:
	cd compatibility/aiogram && $(PYTHON) -m unittest discover -v
python-security:
	$(PYTHON) -m pip_audit --disable-pip --no-deps -r compatibility/aiogram/requirements.txt
