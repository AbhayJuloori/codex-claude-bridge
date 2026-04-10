---
name: project-structure
domains: [backend, frontend, infrastructure]
description: Conventional file layouts for Python/FastAPI, Node/Express, React projects
---

## Project Structure Conventions

### Python / FastAPI
```
project/
├── src/
│   ├── main.py          # FastAPI app factory
│   ├── config.py        # Settings (pydantic BaseSettings)
│   ├── routers/         # One file per resource (users.py, items.py)
│   ├── models/          # SQLAlchemy/Pydantic models
│   ├── services/        # Business logic
│   └── deps.py          # FastAPI dependencies
├── tests/
│   ├── conftest.py      # Fixtures
│   └── test_*.py
├── pyproject.toml
└── README.md
```

### Node / Express / TypeScript
```
src/
├── index.ts             # Entry point
├── server.ts            # Express app factory
├── config.ts            # Zod config schema
├── routes/              # One file per resource
├── services/            # Business logic
├── types/               # Shared types
└── middleware/
tests/
package.json
tsconfig.json
```

### React
```
src/
├── App.tsx
├── components/          # Shared components
├── pages/               # Route-level components
├── hooks/               # Custom hooks
├── lib/                 # Utilities, API clients
└── types/
```

**One concern per file. If a file exceeds 200 lines, split it.**
