---
name: testing
domains: [test, backend, frontend, ml, data]
description: Write tests before implementation, ensure coverage, prefer integration over unit
---

## Testing Standards

**Write tests first.** Before implementing, write the test that will verify correctness.

### Python (pytest)
- All test files: `tests/test_*.py`
- Use `pytest` with `pytest-cov` for coverage
- Prefer integration tests over unit tests for API endpoints
- Use `httpx.AsyncClient` for FastAPI testing
- Minimum: one happy path + one error path per public function

```python
# Good: tests the real behavior
def test_health_endpoint(client):
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"
```

### TypeScript/JavaScript (Jest/Vitest)
- Test files: `*.test.ts` co-located with source
- Use `describe` blocks per feature, `it` blocks per behavior
- Mock external I/O only — never mock your own modules

### Run commands
- Python: `pytest tests/ -v --tb=short`
- Node: `npx jest --passWithNoTests` or `npx vitest run`

**Never mark a task complete if tests fail.**
