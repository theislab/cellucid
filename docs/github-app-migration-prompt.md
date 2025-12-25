# Task: Migrate Cellucid from PAT to GitHub App Authentication

## Context

I have migrated Cellucid's community annotation GitHub sync from PAT-based auth to GitHub App authentication. The backend (Cloudflare Worker) is already set up and working.

**Setup documentation:** `cellucid/docs/github-oauth-cloudflare-setup.md`

**Worker endpoint:** `https://cellucid-github-auth.benkemalim.workers.dev`

## Current State

The codebase currently uses Personal Access Tokens (PAT) for GitHub authentication:
- Users manually paste a PAT into the UI
- Users manually enter their username/handle
- The PAT is used directly for GitHub API calls

## Target State

Migrate entirely to GitHub App OAuth authentication:

### Authentication
- Replace PAT paste-in with "Sign in with GitHub" button
- User identity comes from GitHub API (`GET /auth/user`), not manual input
- Remove all manual username/handle entry - GitHub identity is authoritative
- Store token in memory or sessionStorage (not localStorage)

### Repository Selection
- After login, show repos where the user has installed the GitHub App
- Use `/auth/installations` and `/auth/installation-repos` endpoints
- Users select which repo to use (no manual repo entry)

### Permissions Model
- Read access: any authenticated user can view annotations
- Write access: determined by GitHub permissions (not UI toggles)
- Direct push: for users with write access to the repo
- Branch + PR flow: for contributors without write access

### API Calls
- All GitHub API calls go through the worker proxy (`/api/*`)
- Use user token for authentication: `Authorization: Bearer <token>`

### Worker API Reference
| Endpoint | Method | Description |
|----------|--------|-------------|
| `/auth/login` | GET | Opens GitHub OAuth flow |
| `/auth/callback` | GET | Handles OAuth callback |
| `/auth/user` | GET | Get authenticated user info |
| `/auth/installations` | GET | List user's app installations |
| `/auth/installation-repos` | POST | List repos for an installation `{installation_id}` |
| `/api/*` | ANY | Proxy to GitHub API |

### UX Requirements
- Remove "YOUR HANDLE" style input
- Collect profile info once, associate with GitHub account
- Clean up the community annotation UI to be more coherent
- Show user's GitHub avatar and username after login
- User should be able to add more repo access or revoke using Cellucid UI modals.
- User should be able to switch between repos (and hence annotation)

## Instructions

1. First, explore the codebase to find all PAT-related code and community annotation UI
2. Create a migration plan
3. Implement the migration:
   - Remove PAT input and manual username entry
   - Add GitHub App OAuth login flow
   - Update all GitHub API calls to use the worker proxy
   - Implement repo selection based on installations
   - Update UI to show GitHub identity
4. Ensure backward compatibility is NOT needed - remove PAT code entirely

## Files to Reference

- `cellucid/docs/github-oauth-cloudflare-setup.md` - Backend setup and API docs
- Search for existing PAT/token handling code
- Search for community annotation UI components

---

## Future Improvements to Consider

After the core migration is complete, consider implementing these enhancements:

### High Priority

#### 1. Token Refresh Flow
Currently tokens expire in 8 hours. Add automatic refresh:
```
/auth/refresh - POST { refresh_token } → new access token
```
Frontend should refresh silently before expiration.

#### 2. Offline-First Annotations
- Cache annotations locally (IndexedDB)
- Queue writes when offline
- Sync when back online and based on the user says push etc.
- Show sync status indicator

### Medium Priority

#### 4. Annotation History
- Track who changed what, when
- View annotation version history
- Rollback to previous versions
- Blame view (who annotated each cell type)

#### 6. Granular Permissions UI
Show users clearly:
```
✓ You can read annotations
✓ You can push directly (you have write access)
  - or -
✓ You can submit via Pull Request
```

#### 11. Multi-Repo Support
- User can connect multiple annotation repos
- Switch between repos in UI
- Cross-reference annotations across repos

#### 12. Real-time Collaboration? if possible
- See who else is viewing the same dataset

### Security Enhancements

#### 13. Token Storage
```javascript
// Current: sessionStorage (cleared on tab close)
// Better: in-memory only with refresh token in httpOnly cookie
```

#### 14. Rate Limiting
Add rate limiting to worker:
- Per-user request limits
- Prevent abuse of API proxy

### Quick Wins (Easy to Implement)

| Feature | Effort | Impact |
|---------|--------|--------|
| Show last sync time | Low | Medium |
| "Copy annotation" button | Low | Medium |
| Export annotations as CSV | Low | High |
| Dark/light mode sync | Low | Low |
| Keyboard shortcuts | Low | Medium |
| Search within annotations | Medium | High |

### Suggested Immediate Next Steps (Post-Migration)

1. **Token refresh** - prevents users getting logged out mid-session
2. **Clear permission indicators** - users know what they can/can't do
3. **Conflict detection** - prevents data loss
4. **Export to CSV** - researchers need this for papers

---

*Prompt created: 2025-12-24*
