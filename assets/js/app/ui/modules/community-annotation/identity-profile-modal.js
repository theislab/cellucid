/**
 * @fileoverview The community annotation identity (profile) modal.
 *
 * Owns the dialog that edits the contributor profile written into every
 * annotation file: display name, title, ORCID, and LinkedIn, plus the
 * type-ahead against the public ORCID registry.
 *
 * This is a leaf of the controls module: it reads and writes the annotation
 * session and the GitHub auth session it is given, and it borrows the shared
 * modal owner, but it holds no controller state and never calls back into the
 * sync, role, or rendering paths. Everything it needs arrives through
 * `createIdentityProfileModal`.
 *
 * @module ui/modules/community-annotation/identity-profile-modal
 */

import { toGitHubUserKey } from '../../../community-annotations/github-auth.js';
import {
  assertExactLinkedInHandle,
  assertExactOptionalProfileText,
  assertExactOrcidId,
  isExactOrcidId,
} from '../../../community-annotations/profile-identifiers.js';
import {
  fetchOrcidExpandedSearch,
  fetchOrcidPerson,
} from '../../../community-annotations/orcid-client.js';
import { el, hasAtLeastUnicodeCodePoints } from './dom.js';
import { createDomId } from '../../components/dom-id.js';
import { runExactCleanup } from './cleanup.js';
import {
  COMMUNITY_MODAL_ESCAPE_OWNER,
  removeOwningCommunityModal,
} from './modal-shell.js';
import {
  assertExactAnnotationUserKey,
  assertExactGitHubLogin,
} from './identity-assertions.js';

/**
 * Build the identity modal opener for one community annotation controls
 * instance.
 *
 * @param {object} deps
 * @param {object} deps.session Community annotation session singleton.
 * @param {object} deps.githubAuth GitHub auth session singleton.
 * @param {(options: object) => ({overlay: HTMLElement, content: HTMLElement}|null)} deps.showOwnedCommunityModal
 *   The controls' single-modal owner. Passed in rather than imported so the
 *   modal this dialog opens is the same one the controls can close.
 * @returns {(options?: object) => Promise<object|null>} `editIdentityFlow`
 */
export function createIdentityProfileModal({
  session,
  githubAuth,
  showOwnedCommunityModal,
}) {
  if (
    session === null ||
    typeof session !== 'object' ||
    githubAuth === null ||
    typeof githubAuth !== 'object' ||
    typeof showOwnedCommunityModal !== 'function'
  ) {
    throw new TypeError(
      'The community annotation identity modal requires the session, the GitHub auth session, and the owned modal opener'
    );
  }

      async function editIdentityFlow({
      suggestedUsername = null,
      reason = null,
      returnFocusTo = null,
      returnFocusResolver = null
      } = {}) {
        const current = session.getProfile();
    const authenticatedKey = toGitHubUserKey(githubAuth.getUser());
    const userKey = authenticatedKey === null ? 'local' : authenticatedKey;
    const rawSuggested =
      suggestedUsername === null
        ? current.login
        : suggestedUsername;
    const suggested =
      rawSuggested === ''
        ? ''
        : assertExactGitHubLogin(rawSuggested, 'Suggested GitHub login');
    const remoteFields = userKey ? session.getKnownUserProfile(userKey) : null;

      return new Promise((resolve) => {
        let resolved = false;
        const resolveOnce = (value) => {
          if (resolved) return;
          resolved = true;
          resolve(value);
        };

        let orcidSuggestPopupEl = null;
        let orcidSuggestAnchorEl = null;

        const modalRef = showOwnedCommunityModal({
          title: 'Your identity',
          modalClassName: 'community-annotation-modal--narrow',
          returnFocusTo,
          returnFocusResolver,
          buildContent: (content) => {
            const note = el('div', { className: 'legend-help' });
            note.appendChild(document.createTextNode('Saved locally (like votes) until you Publish; Publish writes it into your GitHub user file. '));
            const optionalEm = document.createElement('em');
            optionalEm.textContent = 'All fields are optional.';
            note.appendChild(optionalEm);
            content.appendChild(note);

          if (reason) content.appendChild(el('div', { className: 'legend-help', text: `⚠ ${String(reason)}` }));

          const status = el('div', {
            className: 'legend-help',
            role: 'status',
            'aria-live': 'polite',
            text: '',
          });
          content.appendChild(status);

            if (suggested) {
              content.appendChild(el('div', { className: 'legend-help', text: `GitHub: @${suggested}` }));
            } else {
              content.appendChild(el('div', {
                className: 'legend-help',
                text: 'GitHub account not available. Sign in to set identity.'
            }));
          }

          const orcidSuggestionListId = createDomId(
            'cellucid-orcid-suggestions'
          );
          const orcidDisclosureId = createDomId(
            'cellucid-orcid-disclosure'
          );
          const nameInputId = createDomId('cellucid-identity-name');
          const titleInputId = createDomId('cellucid-identity-affiliation');
          const linkedinInputId = createDomId('cellucid-identity-linkedin');
          const orcidInputId = createDomId('cellucid-identity-orcid');
          content.appendChild(el('div', {
            id: orcidDisclosureId,
            className: 'community-annotation-external-lookup-disclosure',
            text:
              'Typing 3 or more characters in Name or ORCID searches the ' +
              'public ORCID registry. Requests omit credentials and referrer information.',
          }));
          content.appendChild(el('label', {
            className: 'legend-help',
            for: nameInputId,
            text: 'Name:'
          }));
          const nameInput = el('input', {
            id: nameInputId,
            type: 'text',
            className: 'community-annotation-text-input',
              'aria-label': 'Name',
            'aria-describedby': orcidDisclosureId,
            role: 'combobox',
            'aria-autocomplete': 'list',
            'aria-controls': orcidSuggestionListId,
            'aria-expanded': 'false',
            'aria-haspopup': 'listbox',
            name: 'cellucid_identity_display_name',
            autocomplete: 'off',
            placeholder: 'e.g. Alice Smith',
            value: current?.displayName || remoteFields?.displayName || ''
          });
          content.appendChild(nameInput);

          content.appendChild(el('label', {
            className: 'legend-help',
            for: titleInputId,
            text: 'Affiliation / role:'
          }));
          const titleInput = el('input', {
            id: titleInputId,
            type: 'text',
            className: 'community-annotation-text-input',
            'aria-label': 'Affiliation / role',
            name: 'cellucid_identity_affiliation',
            autocomplete: 'off',
            placeholder: 'e.g. Theis Lab, Postdoc',
            value: current?.title || remoteFields?.title || ''
          });
          content.appendChild(titleInput);

          content.appendChild(el('label', {
            className: 'legend-help',
            for: linkedinInputId,
            text: 'LinkedIn:'
          }));
          const linkedinInput = el('input', {
            id: linkedinInputId,
            type: 'text',
            className: 'community-annotation-text-input',
            'aria-label': 'LinkedIn',
            name: 'cellucid_identity_linkedin',
            autocomplete: 'off',
            autocorrect: 'off',
            autocapitalize: 'off',
            spellcheck: 'false',
            inputmode: 'text',
            placeholder: 'Handle only (no URL). Example: username',
            value: current?.linkedin || remoteFields?.linkedin || ''
          });
          content.appendChild(linkedinInput);

            content.appendChild(el('label', {
              className: 'legend-help',
              for: orcidInputId,
              text: 'ORCID:'
            }));
            const orcidInputName = createDomId('cellucid_identity_orcid');
            const orcidInput = el('input', {
              id: orcidInputId,
              type: 'text',
              className: 'community-annotation-text-input',
              'aria-label': 'ORCID',
              'aria-describedby': orcidDisclosureId,
              role: 'combobox',
              'aria-autocomplete': 'list',
              'aria-controls': orcidSuggestionListId,
              'aria-expanded': 'false',
              'aria-haspopup': 'listbox',
              name: orcidInputName,
              autocomplete: 'off',
              autocorrect: 'off',
              autocapitalize: 'off',
              spellcheck: 'false',
              inputmode: 'text',
              placeholder: 'Type a name or ORCID ID (auto-suggest)',
              value: current?.orcid || remoteFields?.orcid || ''
            });
            content.appendChild(orcidInput);

            const suggestionBox = el('div', {
              id: orcidSuggestionListId,
              className: 'community-annotation-suggest community-annotation-suggest--popup',
              role: 'listbox',
              'aria-label': 'ORCID search suggestions'
            });
            orcidSuggestPopupEl = suggestionBox;
            orcidSuggestAnchorEl = orcidInput;
            let profileModalClosed = false;
            let searchTimer = null;
            let activeSearch = null;
            let activeSearchTimeout = null;
            let hideTimer = null;
            let positionFrame = null;
            let positionTimer = null;
            const orcidSearchCache = new Map();
            const orcidComboboxInputs = [nameInput, orcidInput];
            let suggestionItems = [];
            let activeSuggestionIndex = -1;
            let suggestionOwner = orcidInput;
            let suggestionsOpen = false;

            const positionSuggest = () => {
              if (
                profileModalClosed ||
                !orcidSuggestPopupEl ||
                !orcidSuggestAnchorEl
              ) {
                return;
              }
              const anchorRect = orcidSuggestAnchorEl.getBoundingClientRect();
              const maxH = 180;
              const gap = 6;

              orcidSuggestPopupEl.style.width = `${Math.max(160, Math.floor(anchorRect.width))}px`;
              orcidSuggestPopupEl.style.left = `${Math.floor(anchorRect.left)}px`;

              const spaceBelow = window.innerHeight - anchorRect.bottom;
              const preferAbove = spaceBelow < maxH + gap && anchorRect.top > maxH + gap;
              if (preferAbove) {
                orcidSuggestPopupEl.style.top = `${Math.floor(anchorRect.top - gap)}px`;
                orcidSuggestPopupEl.style.transform = 'translateY(-100%)';
              } else {
                orcidSuggestPopupEl.style.top = `${Math.floor(anchorRect.bottom + gap)}px`;
                orcidSuggestPopupEl.style.transform = '';
              }
            };

            const publishSuggestionState = () => {
              for (const input of orcidComboboxInputs) {
                input.setAttribute(
                  'aria-expanded',
                  suggestionsOpen && input === suggestionOwner
                    ? 'true'
                    : 'false'
                );
                input.removeAttribute('aria-activedescendant');
              }
              for (let index = 0; index < suggestionItems.length; index += 1) {
                const selected =
                  suggestionsOpen && index === activeSuggestionIndex;
                suggestionItems[index].row.setAttribute(
                  'aria-selected',
                  selected ? 'true' : 'false'
                );
                if (selected) {
                  suggestionOwner.setAttribute(
                    'aria-activedescendant',
                    suggestionItems[index].row.id
                  );
                }
              }
            };

            const hideSuggestions = () => {
              suggestionsOpen = false;
              activeSuggestionIndex = -1;
              suggestionBox.style.display = 'none';
              publishSuggestionState();
            };

            const cancelPendingSearchTimer = () => {
              if (searchTimer === null) return false;
              const timer = searchTimer;
              clearTimeout(timer);
              if (searchTimer === timer) searchTimer = null;
              return true;
            };

            const abortActiveSearch = () => {
              if (activeSearch === null) return false;
              const request = activeSearch;
              if (typeof request.abort !== 'function') {
                throw new TypeError(
                  'ORCID search controller must expose abort()'
                );
              }
              activeSearch = null;
              if (activeSearchTimeout !== null) {
                clearTimeout(activeSearchTimeout);
                activeSearchTimeout = null;
              }
              request.abort();
              return true;
            };

            const setActiveSuggestion = (index, owner = suggestionOwner) => {
              if (
                !Number.isSafeInteger(index) ||
                index < 0 ||
                index >= suggestionItems.length
              ) {
                throw new RangeError(
                  'Active ORCID suggestion index is outside the rendered list'
                );
              }
              if (!orcidComboboxInputs.includes(owner)) {
                throw new TypeError(
                  'Active ORCID suggestion owner must be an exact combobox'
                );
              }
              suggestionOwner = owner;
              suggestionsOpen = true;
              activeSuggestionIndex = index;
              publishSuggestionState();
              suggestionItems[index].row.scrollIntoView({
                block: 'nearest',
              });
            };

            const selectSuggestion = (index) => {
              if (
                !Number.isSafeInteger(index) ||
                index < 0 ||
                index >= suggestionItems.length
              ) {
                throw new RangeError(
                  'Selected ORCID suggestion index is outside the rendered list'
                );
              }
              const item = suggestionItems[index];
              orcidInput.value = item.orcid;
              if (item.name) nameInput.value = item.name;
              hideSuggestions();
              if (
                suggestionOwner.isConnected &&
                typeof suggestionOwner.focus === 'function'
              ) {
                suggestionOwner.focus();
              }
            };

            const renderSuggestions = (items, { loading = false } = {}) => {
              if (profileModalClosed) return;
              hideSuggestions();
              suggestionBox.innerHTML = '';
              suggestionItems = [];
              if (loading) {
                // Keep silent: show nothing while searching.
                return;
              }
              if (!Array.isArray(items)) {
                throw new Error('ORCID suggestions must be an array');
              }
              if (!items.length) return;
              for (let index = 0; index < items.length; index += 1) {
                const item = items[index];
                const orcid = assertExactOrcidId(item?.orcid);
                const name =
                  item?.name === null
                    ? ''
                    : assertExactOptionalProfileText(
                        item?.name,
                        'ORCID result name',
                        240
                      );
                const label = name ? `${name} — ${orcid}` : orcid;
                const row = el('button', {
                  id: `${orcidSuggestionListId}-option-${index}`,
                  type: 'button',
                  className: 'community-annotation-suggest-item',
                  role: 'option',
                  'aria-selected': 'false',
                  tabindex: '-1',
                  text: label,
                });
                row.addEventListener('pointerdown', (event) => {
                  event.preventDefault();
                  cancelHide();
                });
                row.addEventListener('click', () => selectSuggestion(index));
                suggestionItems.push({ name, orcid, row });
                suggestionBox.appendChild(row);
              }
              suggestionsOpen = true;
              suggestionBox.style.display = 'block';
              publishSuggestionState();
              if (positionFrame !== null) {
                cancelAnimationFrame(positionFrame);
              }
              if (positionTimer !== null) {
                clearTimeout(positionTimer);
              }
              positionFrame = requestAnimationFrame(() => {
                positionFrame = null;
                positionSuggest();
              });
              positionTimer = setTimeout(() => {
                positionTimer = null;
                positionSuggest();
              }, 60);
            };

            async function searchOrcid(query, { signal } = {}) {
              const q = assertExactOptionalProfileText(query, 'ORCID search query', 240);
              if (!q) return [];

              // Small in-memory cache for snappy UX (per modal open).
              const key = q;
              const cached = orcidSearchCache.get(key);
              if (cached && Date.now() - cached.at < 60_000) return cached.items;

              if (isExactOrcidId(q)) {
                const direct = await fetchOrcidPerson(q, { signal });
                const items = [{ orcid: direct.orcid, name: direct.name }];
                orcidSearchCache.set(key, { at: Date.now(), items });
                return items;
              }

              const out = await fetchOrcidExpandedSearch(q, { signal });
              if (out.length > 0) {
                orcidSearchCache.set(key, { at: Date.now(), items: out });
              }
              return out;
            }

            let lastQuery = '';
              const scheduleSearch = (query, owner) => {
                if (profileModalClosed) return;
                if (!orcidComboboxInputs.includes(owner)) {
                  throw new TypeError(
                    'ORCID search owner must be an exact combobox'
                  );
                }
                suggestionOwner = owner;
                orcidSuggestAnchorEl = owner;
                if (suggestionsOpen) {
                  publishSuggestionState();
                  positionSuggest();
                }
                const q = query;
                if (
                  q === lastQuery &&
                  (
                    searchTimer !== null ||
                    activeSearch !== null ||
                    suggestionsOpen
                  )
                ) {
                  return;
                }
                lastQuery = q;
            cancelPendingSearchTimer();
            abortActiveSearch();

              if (
                typeof q !== 'string' ||
                !q ||
                !hasAtLeastUnicodeCodePoints(q, 3)
              ) {
                renderSuggestions([], { loading: false });
                return;
              }

              searchTimer = setTimeout(async () => {
                searchTimer = null;
                if (
                  profileModalClosed ||
                  document.activeElement !== suggestionOwner
                ) {
                  return;
                }
                const ctrl = new AbortController();
                activeSearch = ctrl;
                renderSuggestions([], { loading: true });
                const timeout = setTimeout(() => {
                  const error = new Error(
                    'ORCID request timed out after 6.5 seconds'
                  );
                  error.name = 'TimeoutError';
                  ctrl.abort(error);
                }, 6500);
                activeSearchTimeout = timeout;
                try {
                  const items = await searchOrcid(q, { signal: ctrl.signal });
                  if (
                    profileModalClosed ||
                    activeSearch !== ctrl ||
                    document.activeElement !== suggestionOwner
                  ) {
                    return;
                  }
                  if (!items.length) {
                    renderSuggestions([], { loading: false });
                    status.textContent = 'No ORCID records matched the exact query.';
                    return;
                  }
                  status.textContent = '';
                  renderSuggestions(items, { loading: false });
                } catch (err) {
                  if (
                    profileModalClosed ||
                    activeSearch !== ctrl ||
                    document.activeElement !== suggestionOwner
                  ) {
                    return;
                  }
                  if (err?.name === 'AbortError') {
                    renderSuggestions([], { loading: false });
                  } else {
                    renderSuggestions([], { loading: false });
                    status.textContent =
                      typeof err?.message === 'string' && err.message
                        ? err.message
                        : 'ORCID lookup failed';
                  }
                } finally {
                  clearTimeout(timeout);
                  if (activeSearchTimeout === timeout) {
                    activeSearchTimeout = null;
                  }
                  if (activeSearch === ctrl) {
                    activeSearch = null;
                  }
                }
                }, 250);
              };

          const onAnyInput = (event) => {
            const owner = event?.currentTarget;
            scheduleSearch(owner?.value, owner);
          };

          nameInput.addEventListener('input', onAnyInput);
          orcidInput.addEventListener('input', onAnyInput);
          const handleComboboxKeydown = (event) => {
            if (
              !suggestionsOpen ||
              suggestionItems.length === 0
            ) {
              return;
            }
            const owner = event.currentTarget;
            let nextIndex = null;
            if (event.key === 'ArrowDown') {
              nextIndex =
                activeSuggestionIndex < 0
                  ? 0
                  : (activeSuggestionIndex + 1) % suggestionItems.length;
            } else if (event.key === 'ArrowUp') {
              nextIndex =
                activeSuggestionIndex < 0
                  ? suggestionItems.length - 1
                  : (
                    activeSuggestionIndex - 1 + suggestionItems.length
                  ) % suggestionItems.length;
            } else if (event.key === 'Home') {
              nextIndex = 0;
            } else if (event.key === 'End') {
              nextIndex = suggestionItems.length - 1;
            } else if (
              event.key === 'Enter' &&
              activeSuggestionIndex >= 0
            ) {
              event.preventDefault();
              event.stopPropagation();
              selectSuggestion(activeSuggestionIndex);
              return;
            } else {
              return;
            }
            event.preventDefault();
            event.stopPropagation();
            setActiveSuggestion(nextIndex, owner);
          };
          nameInput.addEventListener('keydown', handleComboboxKeydown);
          orcidInput.addEventListener('keydown', handleComboboxKeydown);
          const scheduleHide = () => {
            if (profileModalClosed) return;
            if (hideTimer) clearTimeout(hideTimer);
            hideTimer = setTimeout(() => {
              hideTimer = null;
              cancelPendingSearchTimer();
              abortActiveSearch();
              hideSuggestions();
            }, 150);
          };
          const cancelHide = () => {
            if (hideTimer) clearTimeout(hideTimer);
            hideTimer = null;
          };
          const focusCombobox = (event) => {
            cancelHide();
            suggestionOwner = event.currentTarget;
            orcidSuggestAnchorEl = event.currentTarget;
            if (suggestionsOpen) {
              publishSuggestionState();
              positionSuggest();
            } else {
              scheduleSearch(
                event.currentTarget.value,
                event.currentTarget
              );
            }
          };
            nameInput.addEventListener('focus', focusCombobox);
            orcidInput.addEventListener('focus', focusCombobox);
            nameInput.addEventListener('blur', scheduleHide);
            orcidInput.addEventListener('blur', scheduleHide);
          suggestionBox.addEventListener('pointerdown', cancelHide);
          const dismissComboboxSuggestions = () => {
            const ownsTransientUi =
              suggestionsOpen ||
              searchTimer !== null ||
              activeSearch !== null;
            if (!ownsTransientUi) return false;
            cancelPendingSearchTimer();
            abortActiveSearch();
            hideSuggestions();
            return true;
          };
          nameInput[COMMUNITY_MODAL_ESCAPE_OWNER] =
            dismissComboboxSuggestions;
          orcidInput[COMMUNITY_MODAL_ESCAPE_OWNER] =
            dismissComboboxSuggestions;
            const scroller = content.closest('.community-annotation-modal-body');
            const handleScrollerScroll = () => {
              if (suggestionsOpen) positionSuggest();
            };
            const handleWindowResize = () => {
              if (suggestionsOpen) positionSuggest();
            };
            scroller.addEventListener('scroll', handleScrollerScroll, {
              passive: true
            });
            window.addEventListener('resize', handleWindowResize, {
              passive: true
            });
            content.__cellucidCleanup = () => {
              profileModalClosed = true;
              runExactCleanup('Community annotation profile teardown', [
                [
                  'ORCID debounce timer',
                  searchTimer === null
                    ? null
                    : () => {
                      const timer = searchTimer;
                      clearTimeout(timer);
                      if (searchTimer === timer) searchTimer = null;
                    }
                ],
                [
                  'ORCID request timeout',
                  activeSearchTimeout === null
                    ? null
                    : () => {
                      const timer = activeSearchTimeout;
                      clearTimeout(timer);
                      if (activeSearchTimeout === timer) {
                        activeSearchTimeout = null;
                      }
                    }
                ],
                [
                  'ORCID suggestion hide timer',
                  hideTimer === null
                    ? null
                    : () => {
                      const timer = hideTimer;
                      clearTimeout(timer);
                      if (hideTimer === timer) hideTimer = null;
                    }
                ],
                [
                  'ORCID suggestion position frame',
                  positionFrame === null
                    ? null
                    : () => {
                      const frame = positionFrame;
                      cancelAnimationFrame(frame);
                      if (positionFrame === frame) positionFrame = null;
                    }
                ],
                [
                  'ORCID suggestion position timer',
                  positionTimer === null
                    ? null
                    : () => {
                      const timer = positionTimer;
                      clearTimeout(timer);
                      if (positionTimer === timer) positionTimer = null;
                    }
                ],
                [
                  'ORCID request',
                  activeSearch === null
                    ? null
                    : () => {
                      const request = activeSearch;
                      request.abort();
                      if (activeSearch === request) activeSearch = null;
                    }
                ],
                [
                  'ORCID suggestion scroll listener',
                  () => scroller.removeEventListener(
                    'scroll',
                    handleScrollerScroll
                  )
                ],
                [
                  'ORCID suggestion resize listener',
                  () => window.removeEventListener(
                    'resize',
                    handleWindowResize
                  )
                ],
                [
                  'ORCID combobox Escape owners',
                  () => {
                    nameInput[COMMUNITY_MODAL_ESCAPE_OWNER] = null;
                    orcidInput[COMMUNITY_MODAL_ESCAPE_OWNER] = null;
                  }
                ],
                ['ORCID suggestion cache', () => orcidSearchCache.clear()]
              ]);
            };

          const actions = el('div', { className: 'community-annotation-suggestion-actions' });
          const saveBtn = el('button', { type: 'button', className: 'btn-small', text: 'Save' });
          const cancelBtn = el('button', { type: 'button', className: 'btn-small', text: 'Cancel' });
          actions.appendChild(saveBtn);
          actions.appendChild(cancelBtn);
          content.appendChild(actions);

              cancelBtn.addEventListener('click', () => {
                removeOwningCommunityModal(content);
                resolveOnce(null);
              });

          saveBtn.addEventListener('click', () => {
            let savedProfile;
            try {
              const login = assertExactGitHubLogin(
                suggested,
                'Authenticated GitHub login'
              );
              const nextProfile = {
                ...current,
                username: assertExactAnnotationUserKey(
                  userKey,
                  'Authenticated annotation identity'
                ),
                login,
                displayName: assertExactOptionalProfileText(
                  nameInput.value,
                  'Name',
                  120
                ),
                title: assertExactOptionalProfileText(
                  titleInput.value,
                  'Affiliation / role',
                  120
                ),
                orcid: assertExactOrcidId(orcidInput.value, {
                  allowEmpty: true,
                }),
                linkedin: assertExactLinkedInHandle(linkedinInput.value, {
                  allowEmpty: true,
                })
              };
              session.setProfile(nextProfile);
              savedProfile = { username: userKey, dismissed: false };
            } catch (error) {
              status.textContent =
                typeof error?.message === 'string' && error.message
                  ? error.message
                  : 'Profile validation failed';
              return;
            }
            try {
              removeOwningCommunityModal(content);
            } finally {
              resolveOnce(savedProfile);
            }
          });
          }
        });

        const overlay = modalRef?.overlay || null;
        if (!overlay) {
          resolveOnce(null);
          return;
        }
        if (orcidSuggestPopupEl) {
          overlay.appendChild(orcidSuggestPopupEl);
        }
        const observer = new MutationObserver(() => {
          if (resolved) {
            observer.disconnect();
            return;
          }
        if (!document.body.contains(overlay)) {
          observer.disconnect();
          resolveOnce(null);
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });
    });
  }

  return editIdentityFlow;
}
