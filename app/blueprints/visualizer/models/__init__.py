"""Model OOP venue: abstract base class + implementasi Cinema XXI dan GBK.

`get_venue()` adalah satu-satunya pintu masuk yang dipakai routes & engine.
"""
from __future__ import annotations

from functools import lru_cache

from .base_venue import SeatNode, SeatNotFoundError, TargetStage, Venue, VenueKind
from .cinema_xxi import FourDXStudio, IMAXStudio, PremiereStudio, RegularStudio
from .concert_gbk import ColdplayGBKStadium

_VENUE_CLASSES: tuple[type[Venue], ...] = (
    RegularStudio,
    PremiereStudio,
    IMAXStudio,
    FourDXStudio,
    ColdplayGBKStadium,
)


@lru_cache(maxsize=1)
def venue_registry() -> dict[str, Venue]:
    """Bangun semua venue sekali saja (lazy singleton), urutannya = urutan tab di UI."""
    venues = [cls() for cls in _VENUE_CLASSES]
    return {venue.venue_id: venue for venue in venues}


def get_venue(venue_id: str) -> Venue:
    try:
        return venue_registry()[venue_id]
    except KeyError as exc:
        raise SeatNotFoundError(f"Venue '{venue_id}' tidak dikenal.") from exc


__all__ = [
    "ColdplayGBKStadium", "FourDXStudio", "IMAXStudio", "PremiereStudio", "RegularStudio",
    "SeatNode", "SeatNotFoundError", "TargetStage", "Venue", "VenueKind",
    "get_venue", "venue_registry",
]
