---
name: code-quality
domains: [backend, frontend, ui, ml, data, test, infrastructure]
description: Type hints, no magic values, clear naming, proper error handling at boundaries
---

## Code Quality Standards

### Always
- Add type hints to all function signatures (Python) or TypeScript types to all exports
- Use named constants for any repeated literal values
- One responsibility per function — if it does two things, split it
- Meaningful names: `user_id` not `uid`, `fetch_user_profile` not `get_data`

### Error handling
- Validate at system boundaries (HTTP request input, file reads, external APIs)
- Do not validate internal function arguments — trust your own code
- Use specific exception types, not bare `except:` or `catch (e) {}`

### Python
```python
# Good
def fetch_user(user_id: int) -> User:
    if user_id <= 0:
        raise ValueError(f"Invalid user_id: {user_id}")
    ...

# Bad
def get(id):
    try:
        ...
    except:
        return None
```

### TypeScript
```typescript
// Good
export function parseConfig(raw: unknown): Config {
  return configSchema.parse(raw); // Zod throws with message
}

// Bad
export function parseConfig(raw: any) {
  try { return JSON.parse(raw); } catch { return {}; }
}
```

### Never
- No `print`/`console.log` in production code — use a logger
- No commented-out code
- No TODO in final output
