/** Crawl-local destination ownership; retains identities, never resource bodies. */
export class PublicationReservations {
  private readonly destinations = new Map<string, {owner: string; active: number; published: boolean}>();

  claim(destination: string, owner: string): (published: boolean) => void {
    const existing = this.destinations.get(destination);
    if (existing && existing.owner !== owner) {
      throw Object.assign(new Error(`Output destination is already owned by ${existing.owner}: ${destination}`),
        {code: 'ERR_OUTPUT_CONFLICT', destination, owner: existing.owner});
    }
    const reservation = existing ?? {owner, active: 0, published: false};
    ++reservation.active;
    this.destinations.set(destination, reservation);
    let released = false;
    return published => {
      if (released) return;
      released = true;
      reservation.published ||= published;
      --reservation.active;
      if (!reservation.active && !reservation.published) this.destinations.delete(destination);
    };
  }
}
