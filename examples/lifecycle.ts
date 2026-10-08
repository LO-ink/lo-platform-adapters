import {
  bindAppearance,
  requestWriteAccess,
  type MiniAppClient,
} from "@lo-ink/miniapp-sdk";

/** Own one live client; cached-page restoration starts a fresh host session. */
export async function startExample(
  createClient: () => MiniAppClient | Promise<MiniAppClient>,
): Promise<void> {
  const media = matchMedia("(prefers-color-scheme: dark)");
  const button = document.querySelector("#request-messages");
  let generation = 0;
  let visible = true;
  let ended = false;
  let active:
    | {
        client: MiniAppClient;
        stopAppearance: () => void;
        ready: boolean;
        requesting: boolean;
      }
    | undefined;

  function release() {
    const session = active;
    active = undefined;
    delete document.documentElement.dataset.writeAccess;
    if (!session) return;
    try {
      session.stopAppearance();
    } finally {
      session.client.dispose();
    }
  }

  async function start(initial = false) {
    const attempt = ++generation;
    document.documentElement.dataset.miniappState = "connecting";
    let client: MiniAppClient;
    try {
      client = await createClient();
    } catch (error) {
      if (!visible || ended || attempt !== generation) return;
      document.documentElement.dataset.miniappState = "unavailable";
      throw error;
    }
    if (!visible || ended || attempt !== generation) {
      client.dispose();
      return;
    }
    const session = {
      client,
      stopAppearance: () => {},
      ready: false,
      requesting: false,
    };
    active = session;
    try {
      session.stopAppearance = bindAppearance(client, {
        root: document.documentElement,
        prefersDark: () => media.matches,
        background: (name) =>
          getComputedStyle(document.documentElement).getPropertyValue(name),
        onPreferenceChange: (listener) => {
          media.addEventListener("change", listener);
          return () => media.removeEventListener("change", listener);
        },
      });
      for (const operation of ["ready", "expand"] as const) {
        if (active !== session) return;
        if (operation === "expand" && !initial) continue;
        if (client.supports(operation)) await client.call(operation, undefined);
      }
      if (active === session) {
        session.ready = true;
        document.documentElement.dataset.miniappState = "ready";
      }
    } catch (error) {
      if (active !== session) return;
      release();
      document.documentElement.dataset.miniappState = "unavailable";
      throw error;
    }
  }

  async function requestMessages() {
    const session = active;
    if (!session?.ready || session.requesting) return;
    session.requesting = true;
    try {
      const allowed = await requestWriteAccess(session.client);
      if (active === session)
        document.documentElement.dataset.writeAccess = allowed
          ? "allowed"
          : "denied";
    } catch {
      if (active === session)
        document.documentElement.dataset.writeAccess = "error";
    } finally {
      session.requesting = false;
    }
  }

  function hide(event: PageTransitionEvent) {
    visible = false;
    generation++;
    release();
    document.documentElement.dataset.miniappState = "suspended";
    if (!event.persisted) {
      ended = true;
      button?.removeEventListener("click", requestMessages);
      removeEventListener("pagehide", hide);
      removeEventListener("pageshow", show);
    }
  }

  function show(event: PageTransitionEvent) {
    if (!event.persisted || visible || ended) return;
    visible = true;
    const attempt = generation + 1;
    void start().catch(() => {
      if (visible && !ended && attempt === generation)
        document.documentElement.dataset.miniappState = "unavailable";
    });
  }

  button?.addEventListener("click", requestMessages);
  addEventListener("pagehide", hide);
  addEventListener("pageshow", show);
  await start(true);
}
