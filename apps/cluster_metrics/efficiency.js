'use strict';
/**
 * efficiency.js - rolling distance-weighted EV (km/kWh) and Fuel (L/100km) trackers,
 * instant vs average comparisons, CDS2.statusInjectionVolume delta calibration, and DFCO.
 *
 * IMPORTANT DESIGN RULE (User Review Comment #2):
 * When the car stops at a traffic light (speedKmh <= 1.5), rolling EV efficiency holds
 * steady (never switches hero display to "kW IDLE"), because live HVAC/power kW is
 * already displayed continuously on the secondary line directly below.
 *
 * Strict Node 8.16.2 (ES2017): no optional chaining, no ??, no dependencies.
 */

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

class EfficiencyTracker {
    constructor(opts) {
        const o = opts || {};
        this.evTauKm = o.evTauKm || 5.0;
        this.evInstTauKm = o.evInstTauKm || 0.25;
        this.fuelTauKm = o.fuelTauKm || 0.24;
        this.fuelInstTauKm = o.fuelInstTauKm || 0.20;
        this.reset();
    }

    reset() {
        this.lastT = 0;
        // Rolling EV integration
        this.evDistWeight = 0;
        this.evKwhWeight = 0;
        this.evTotalDistKm = 0;
        this.evInstDistWeight = 0;
        this.evInstKwhWeight = 0;

        // Rolling Fuel integration
        this.fuelDistWeight = 0;
        this.fuelLWeight = 0;
        this.fuelTotalDistKm = 0;
        this.fuelInstDistWeight = 0;
        this.fuelInstLWeight = 0;

        // CDS2 16-bit injection volume counter integrator + auto-calibrator against DME L/h
        this.lastInjRaw = null;
        this.lastInjChangeT = 0;
        this.injAccCounts = 0;
        this.injAccDtS = 0;
        this.injFlowUlPerSec = null;
        this.injRateT = 0;
        this.ulPerCount = 1.0;
        this.injCalibrated = false;

        this.lastBcL100 = null;
        this.isDfco = false;
    }

    _updateInjectionFlow(injRaw, nowMs, dmeFuelLh, rpm) {
        if (typeof injRaw === 'number' && isFinite(injRaw) && injRaw >= 0 && injRaw < 65535) {
            if (this.lastInjRaw !== null && this.lastInjChangeT > 0) {
                const dtS = (nowMs - this.lastInjChangeT) / 1000;
                if (dtS > 5.0) {
                    this.injAccCounts = 0;
                    this.injAccDtS = 0;
                    this.lastInjRaw = injRaw;
                    this.lastInjChangeT = nowMs;
                } else if (injRaw !== this.lastInjRaw && dtS >= 0.02) {
                    // UInt16 counter wraps modulo 65536; ignore implausible jumps > 40000
                    const delta = (injRaw >= this.lastInjRaw)
                        ? (injRaw - this.lastInjRaw)
                        : ((injRaw - this.lastInjRaw + 65536) % 65536);
                    if (delta > 0 && delta < 40000) {
                        this.injAccCounts += delta;
                        this.injAccDtS += dtS;
                        if (this.injAccDtS >= 0.25) {
                            const rawRate = this.injAccCounts / this.injAccDtS;
                            this.injFlowUlPerSec = this.injFlowUlPerSec === null
                                ? rawRate
                                : this.injFlowUlPerSec * 0.55 + rawRate * 0.45;
                            this.injRateT = nowMs;
                            this.injAccCounts = 0;
                            this.injAccDtS = 0;
                        }
                    }
                    this.lastInjRaw = injRaw;
                    this.lastInjChangeT = nowMs;
                } else if (dtS >= 1.2 && injRaw === this.lastInjRaw) {
                    // Counter stopped advancing (DFCO coasting or engine off)
                    this.injFlowUlPerSec = 0;
                    this.injRateT = nowMs;
                    this.injAccCounts = 0;
                    this.injAccDtS = 0;
                    this.lastInjChangeT = nowMs;
                }
            } else {
                this.lastInjRaw = injRaw;
                this.lastInjChangeT = nowMs;
            }
        }
        // Calibrate uL-per-count smoothly when DME UDS fuelRate (L/h) is available alongside live counter rate
        if (typeof dmeFuelLh === 'number' && isFinite(dmeFuelLh) && dmeFuelLh > 0.3 &&
            this.injFlowUlPerSec !== null && this.injFlowUlPerSec > 5 &&
            (nowMs - this.injRateT) <= 2000 && rpm > 500) {
            const targetUlPerSec = (dmeFuelLh * 1e6) / 3600;
            const estFactor = clamp(targetUlPerSec / this.injFlowUlPerSec, 0.02, 50.0);
            this.ulPerCount = this.injCalibrated ? (this.ulPerCount * 0.75 + estFactor * 0.25) : estFactor;
            this.injCalibrated = true;
        }
    }

    /**
     * Feed one telemetry sample and return current rolling & instant metrics:
     * { evKmPerKwh, evInstKmPerKwh, fuelLPer100km, fuelInstLPer100km, lPerHour, isDfco }
     */
    update(sample, nowMs) {
        const s = sample || {};
        const t = typeof nowMs === 'number' && isFinite(nowMs) ? nowMs : Date.now();
        const dtS = this.lastT > 0 ? clamp((t - this.lastT) / 1000, 0, 2.5) : 0;
        this.lastT = t;

        const speedKmh = typeof s.speedKmh === 'number' && isFinite(s.speedKmh) ? Math.max(0, s.speedKmh) : 0;
        const rpm = typeof s.rpm === 'number' && isFinite(s.rpm) ? Math.max(0, s.rpm) : 0;
        const engineOn = typeof s.engineOn === 'boolean' ? s.engineOn : (rpm >= 450);
        const hvKw = typeof s.hvKw === 'number' && isFinite(s.hvKw) ? s.hvKw : null;
        const dmeFuelLh = typeof s.dmeFuelLh === 'number' && isFinite(s.dmeFuelLh) ? s.dmeFuelLh : null;
        const bcL100 = typeof s.bcFuelLPer100km === 'number' && isFinite(s.bcFuelLPer100km) && s.bcFuelLPer100km > 0
            ? s.bcFuelLPer100km : null;
        if (bcL100 !== null) this.lastBcL100 = bcL100;

        this._updateInjectionFlow(s.injVolumeRaw, t, dmeFuelLh, rpm);

        // Determine instantaneous fuel flow (L/h): prefer fast SOME/IP injection counter once calibrated
        // against DME UDS fuelRate so throttle changes and DFCO respond immediately between 1s UDS reads.
        let lPerHour = null;
        const injFresh = this.injFlowUlPerSec !== null && (t - this.injRateT) <= 1800;
        if (!engineOn || rpm < 250) {
            lPerHour = 0;
        } else if (this.injCalibrated && injFresh) {
            lPerHour = Math.max(0, (this.injFlowUlPerSec * this.ulPerCount * 3600) / 1e6);
        } else if (dmeFuelLh !== null) {
            lPerHour = Math.max(0, dmeFuelLh);
        } else if (injFresh) {
            lPerHour = Math.max(0, (this.injFlowUlPerSec * this.ulPerCount * 3600) / 1e6);
        } else if (this.lastBcL100 !== null && speedKmh > 3) {
            lPerHour = (this.lastBcL100 * speedKmh) / 100;
        }

        // Direct provided instant km/kWh override (for demo / simulation precision if desired)
        const dtHours = dtS / 3600;
        const dKm = speedKmh * dtHours;

        // 1) Electric efficiency integration (holds rolling number at 0 mph!)
        if (!engineOn && hvKw !== null && dKm > 0 && speedKmh > 1.5) {
            const dKwh = hvKw * dtHours;
            this.evTotalDistKm += dKm;

            const decay = Math.exp(-dKm / this.evTauKm);
            this.evDistWeight = this.evDistWeight * decay + dKm;
            this.evKwhWeight = this.evKwhWeight * decay + dKwh;

            const iDecay = Math.exp(-dKm / this.evInstTauKm);
            this.evInstDistWeight = this.evInstDistWeight * iDecay + dKm;
            this.evInstKwhWeight = this.evInstKwhWeight * iDecay + dKwh;
        }

        let evKmPerKwh = null;
        if (this.evTotalDistKm >= 0.08 && this.evDistWeight > 0) {
            // Protect against sustained downhill net-zero/negative rolling window
            if (this.evKwhWeight > 0.002) {
                evKmPerKwh = clamp(this.evDistWeight / this.evKwhWeight, 0.8, 19.0);
            } else {
                evKmPerKwh = 19.0;
            }
        }

        let evInstKmPerKwh = null;
        if (this.evInstDistWeight > 0.02) {
            if (this.evInstKwhWeight > 0.0005) {
                evInstKmPerKwh = clamp(this.evInstDistWeight / this.evInstKwhWeight, 0.8, 19.0);
            } else if (hvKw !== null && hvKw <= 0.1) {
                evInstKmPerKwh = 19.0;
            }
        }

        // 2) Fuel efficiency integration (holds rolling number at 0 mph!)
        this.isDfco = Boolean(engineOn && speedKmh > 20 && lPerHour !== null && lPerHour < 0.15);
        if (engineOn && lPerHour !== null && dKm > 0 && speedKmh > 1.5) {
            const dL = lPerHour * dtHours;
            this.fuelTotalDistKm += dKm;

            const decay = Math.exp(-dKm / this.fuelTauKm);
            this.fuelDistWeight = this.fuelDistWeight * decay + dKm;
            this.fuelLWeight = this.fuelLWeight * decay + dL;

            const iDecay = Math.exp(-dKm / this.fuelInstTauKm);
            this.fuelInstDistWeight = this.fuelInstDistWeight * iDecay + dKm;
            this.fuelInstLWeight = this.fuelInstLWeight * iDecay + dL;
        }

        let fuelLPer100km = null;
        if (this.fuelTotalDistKm >= 0.08 && this.fuelDistWeight > 0) {
            fuelLPer100km = clamp((this.fuelLWeight / this.fuelDistWeight) * 100, 0.5, 99.9);
        } else if (this.lastBcL100 !== null) {
            fuelLPer100km = clamp(this.lastBcL100, 0.5, 99.9);
        }

        let fuelInstLPer100km = null;
        if (engineOn && speedKmh > 5 && lPerHour !== null) {
            fuelInstLPer100km = clamp((lPerHour / speedKmh) * 100, 0, 99.9);
        }

        return {
            evKmPerKwh,
            evInstKmPerKwh,
            fuelLPer100km,
            fuelInstLPer100km,
            lPerHour,
            isDfco: this.isDfco,
        };
    }
}

module.exports = { EfficiencyTracker };
