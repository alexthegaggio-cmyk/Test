// Skyward — SW.DATA.meteorShowers: the major annual showers, hand-authored from the IMO working list
// (International Meteor Organization meteor shower calendar). Dates are calendar month/day of the
// activity window and of the maximum (they drift by at most a day from year to year); zhr is the peak
// Zenithal Hourly Rate (meteors/hour under ideal conditions; 'variable' showers carry their typical
// value); ra/dec is the radiant at maximum in degrees (J2000, RA 0–360); velocity is the atmospheric
// entry speed in km/s; parent is the source comet or asteroid.
(function (root) {
  'use strict';
  const SW = root.SW = root.SW || {};
  SW.DATA = SW.DATA || {};

  SW.DATA.meteorShowers = [
    { id: 'QUA', name: 'Quadrantids', peak: { month: 1, day: 3 }, start: { month: 12, day: 28 }, end: { month: 1, day: 12 },
      zhr: 110, ra: 230, dec: 49, velocity: 41, parent: '(196256) 2003 EH1' },
    { id: 'LYR', name: 'Lyrids', peak: { month: 4, day: 22 }, start: { month: 4, day: 14 }, end: { month: 4, day: 30 },
      zhr: 18, ra: 271, dec: 34, velocity: 49, parent: 'C/1861 G1 Thatcher' },
    { id: 'ETA', name: 'Eta Aquariids', peak: { month: 5, day: 6 }, start: { month: 4, day: 19 }, end: { month: 5, day: 28 },
      zhr: 50, ra: 338, dec: -1, velocity: 66, parent: '1P/Halley' },
    { id: 'CAP', name: 'Alpha Capricornids', peak: { month: 7, day: 30 }, start: { month: 7, day: 3 }, end: { month: 8, day: 15 },
      zhr: 5, ra: 307, dec: -10, velocity: 23, parent: '169P/NEAT' },
    { id: 'SDA', name: 'Southern Delta Aquariids', peak: { month: 7, day: 30 }, start: { month: 7, day: 12 }, end: { month: 8, day: 23 },
      zhr: 25, ra: 340, dec: -16, velocity: 41, parent: '96P/Machholz' },
    { id: 'PER', name: 'Perseids', peak: { month: 8, day: 12 }, start: { month: 7, day: 17 }, end: { month: 8, day: 24 },
      zhr: 100, ra: 48, dec: 58, velocity: 59, parent: '109P/Swift–Tuttle' },
    { id: 'AUR', name: 'Aurigids', peak: { month: 8, day: 31 }, start: { month: 8, day: 28 }, end: { month: 9, day: 5 },
      zhr: 6, ra: 91, dec: 39, velocity: 66, parent: 'C/1911 N1 Kiess' },
    { id: 'SPE', name: 'September Epsilon Perseids', peak: { month: 9, day: 9 }, start: { month: 9, day: 5 }, end: { month: 9, day: 21 },
      zhr: 5, ra: 48, dec: 40, velocity: 64, parent: 'unknown' },
    { id: 'STA', name: 'Southern Taurids', peak: { month: 10, day: 10 }, start: { month: 9, day: 10 }, end: { month: 11, day: 20 },
      zhr: 5, ra: 32, dec: 9, velocity: 27, parent: '2P/Encke' },
    { id: 'DRA', name: 'Draconids', peak: { month: 10, day: 8 }, start: { month: 10, day: 6 }, end: { month: 10, day: 10 },
      zhr: 10, ra: 262, dec: 54, velocity: 20, parent: '21P/Giacobini–Zinner' },
    { id: 'ORI', name: 'Orionids', peak: { month: 10, day: 21 }, start: { month: 10, day: 2 }, end: { month: 11, day: 7 },
      zhr: 20, ra: 95, dec: 16, velocity: 66, parent: '1P/Halley' },
    { id: 'NTA', name: 'Northern Taurids', peak: { month: 11, day: 12 }, start: { month: 10, day: 20 }, end: { month: 12, day: 10 },
      zhr: 5, ra: 58, dec: 22, velocity: 29, parent: '2004 TG10 (Encke complex)' },
    { id: 'LEO', name: 'Leonids', peak: { month: 11, day: 17 }, start: { month: 11, day: 6 }, end: { month: 11, day: 30 },
      zhr: 10, ra: 152, dec: 22, velocity: 71, parent: '55P/Tempel–Tuttle' },
    { id: 'GEM', name: 'Geminids', peak: { month: 12, day: 14 }, start: { month: 12, day: 4 }, end: { month: 12, day: 20 },
      zhr: 150, ra: 112, dec: 33, velocity: 35, parent: '(3200) Phaethon' },
    { id: 'URS', name: 'Ursids', peak: { month: 12, day: 22 }, start: { month: 12, day: 17 }, end: { month: 12, day: 26 },
      zhr: 10, ra: 217, dec: 76, velocity: 33, parent: '8P/Tuttle' }
  ];
})(typeof globalThis !== 'undefined' ? globalThis : window);
