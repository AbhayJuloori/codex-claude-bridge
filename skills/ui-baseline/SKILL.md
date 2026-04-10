---
name: ui-baseline
domains: [ui, frontend]
description: Build correct structure and data flow. Claude will rewrite visual quality.
---

## UI Baseline Guidelines

You are building a **functional skeleton** only. Claude will handle the visual polish.

### Your job
- Correct component hierarchy
- All data flows working (props, state, API calls)
- Routing in place
- All interactive states wired (click handlers, form submissions)
- Accessible HTML structure (semantic tags, labels, aria where obvious)

### Not your job
- Pixel-perfect styling
- Animation or transitions
- Color schemes or typography choices
- Complex responsive layouts

### React baseline pattern
```tsx
// Do: functional structure with all logic wired
export function UserList({ users }: { users: User[] }) {
  return (
    <div className="user-list">
      {users.map((user) => (
        <div key={user.id} className="user-card">
          <h3>{user.name}</h3>
          <p>{user.email}</p>
          <button onClick={() => onSelect(user)}>Select</button>
        </div>
      ))}
    </div>
  );
}
```

**Deliver working logic. Claude rewrites the rest.**
