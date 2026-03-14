const STORAGE_KEY = "tracked_players";

export function getTrackedPlayers(): string[] {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
  } catch {
    return [];
  }
}

export function addTrackedPlayer(playerSlug: string): void {
  const players = getTrackedPlayers();
  if (!players.includes(playerSlug)) {
    players.push(playerSlug);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(players));
  }
}

export function removeTrackedPlayer(playerSlug: string): void {
  const players = getTrackedPlayers().filter(s => s !== playerSlug);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(players));
}

export function isTrackedPlayer(playerSlug: string): boolean {
  return getTrackedPlayers().includes(playerSlug);
}

/** Toggle tracked state; returns the new tracked state */
export function toggleTrackedPlayer(playerSlug: string): boolean {
  if (isTrackedPlayer(playerSlug)) {
    removeTrackedPlayer(playerSlug);
    return false;
  }
  addTrackedPlayer(playerSlug);
  return true;
}
