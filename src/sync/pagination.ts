import { fingerprintOpaqueValue } from "./pagination-fingerprint.ts";
import type { SyncDegradation } from "./sync-degradation.ts";

type PageKey = string | number;

export interface ProviderPage<TItem, TPageKey extends PageKey = string> {
  items: TItem[];
  nextCursor: TPageKey | null;
}

export interface FetchProviderPagesOptions<TItem, TPageKey extends PageKey = string> {
  providerId: string;
  stepName: string;
  initialCursor?: TPageKey;
  maxPages?: number;
  fetchPage(cursor: TPageKey | undefined): Promise<ProviderPage<TItem, TPageKey>>;
  onPage?(page: ProviderPage<TItem, TPageKey>, allItems: readonly TItem[]): Promise<void> | void;
  shouldStopAfterPage?(page: ProviderPage<TItem, TPageKey>, allItems: readonly TItem[]): boolean;
}

export interface FetchProviderPagesResult<TItem> {
  items: TItem[];
  degradations: SyncDegradation[];
  pagesFetched: number;
  finalCursor: string | null;
  completed: boolean;
  stoppedByProviderRule: boolean;
}

const DEFAULT_MAX_PROVIDER_PAGES = 100;

function pageKeyIdentity(pageKey: PageKey): string {
  return `${typeof pageKey}:${String(pageKey)}`;
}

function pageKeysEqual(leftPageKey: PageKey, rightPageKey: PageKey): boolean {
  return pageKeyIdentity(leftPageKey) === pageKeyIdentity(rightPageKey);
}

class ProviderPaginationGuard<TItem, TPageKey extends PageKey = string> {
  readonly #options: FetchProviderPagesOptions<TItem, TPageKey>;
  readonly #seenPageKeys = new Set<string>();
  readonly #items: TItem[] = [];
  readonly #degradations: SyncDegradation[] = [];
  #pagesFetched = 0;
  #finalCursor: string | null = null;
  #completed = false;
  #stoppedByProviderRule = false;

  constructor(options: FetchProviderPagesOptions<TItem, TPageKey>) {
    this.#options = options;
  }

  async fetchAll(): Promise<FetchProviderPagesResult<TItem>> {
    let currentCursor = this.#options.initialCursor;

    while (!this.#completed && this.#degradations.length === 0) {
      if (currentCursor !== undefined) {
        this.#seenPageKeys.add(pageKeyIdentity(currentCursor));
      }

      const page = await this.#options.fetchPage(currentCursor);
      this.#pagesFetched += 1;
      this.#items.push(...page.items);
      this.#finalCursor = page.nextCursor == null ? null : String(page.nextCursor);

      await this.#options.onPage?.(page, this.#items);

      if (this.#options.shouldStopAfterPage?.(page, this.#items) === true) {
        this.#stoppedByProviderRule = true;
        this.#completed = true;
        break;
      }

      if (page.nextCursor == null) {
        this.#completed = true;
        break;
      }

      if (page.items.length === 0) {
        this.#addDegradation(
          "pagination_empty_page_with_cursor",
          "Provider returned an empty page with a continuation cursor",
          page.nextCursor,
        );
        break;
      }

      if (currentCursor !== undefined && pageKeysEqual(page.nextCursor, currentCursor)) {
        this.#addDegradation(
          "pagination_stalled",
          "Provider returned the same pagination cursor",
          page.nextCursor,
        );
        break;
      }

      if (this.#seenPageKeys.has(pageKeyIdentity(page.nextCursor))) {
        this.#addDegradation(
          "pagination_stalled",
          "Provider returned a previously seen pagination cursor",
          page.nextCursor,
        );
        break;
      }

      if (this.#pagesFetched >= (this.#options.maxPages ?? DEFAULT_MAX_PROVIDER_PAGES)) {
        this.#addDegradation(
          "pagination_max_pages_exceeded",
          "Provider pagination exceeded the maximum page count",
          page.nextCursor,
        );
        break;
      }

      currentCursor = page.nextCursor;
    }

    return {
      items: this.#items,
      degradations: this.#degradations,
      pagesFetched: this.#pagesFetched,
      finalCursor: this.#finalCursor,
      completed: this.#completed,
      stoppedByProviderRule: this.#stoppedByProviderRule,
    };
  }

  #addDegradation(kind: SyncDegradation["kind"], message: string, pageKey: TPageKey): void {
    this.#finalCursor = null;
    this.#degradations.push({
      kind,
      providerId: this.#options.providerId,
      stepName: this.#options.stepName,
      message,
      context: {
        cursorFingerprint: fingerprintOpaqueValue(pageKey),
        pagesFetched: this.#pagesFetched,
      },
    });
  }
}

export async function fetchProviderPages<TItem, TPageKey extends PageKey = string>(
  options: FetchProviderPagesOptions<TItem, TPageKey>,
): Promise<FetchProviderPagesResult<TItem>> {
  return new ProviderPaginationGuard(options).fetchAll();
}
