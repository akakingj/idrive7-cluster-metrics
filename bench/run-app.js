'use strict';
/**
 * bench/run-app.js - Child worker launching the staged dist/cluster_metrics bundle
 * inside MGU App Kit's hu-stub runtime and streaming telemetry to bench/server.js.
 */

const fs = require('fs');
const path = require('path');

const stageDir = process.argv[2];
const dataRoot = process.argv[3];
if (!stageDir || !dataRoot) {
    console.error('usage: node bench/run-app.js <dist/cluster_metrics> <dataDir>');
    process.exit(2);
}

const VENDOR_TOOLS = path.join(__dirname, '..', 'vendor', 'cauliflowermossgrape-idrive7-apps', 'kit', 'tools');

function postToParent(msg) {
    if (typeof process.send === 'function' && process.connected) process.send(msg);
}

function formatArgs(args) {
    const out = [];
    for (let i = 0; i < args.length; i++) {
        const item = args[i];
        if (item && item.stack) out.push(item.stack);
        else if (typeof item === 'object') out.push(JSON.stringify(item));
        else out.push(String(item));
    }
    return out.join(' ');
}

const benchLogger = {
    info() {
        const s = formatArgs(arguments);
        console.log('[cluster_metrics] ' + s);
        postToParent({ t: 'log', level: 'info', s });
    },
    warn() {
        const s = formatArgs(arguments);
        console.warn('[cluster_metrics] WARN ' + s);
        postToParent({ t: 'log', level: 'warn', s });
    },
    error() {
        const s = formatArgs(arguments);
        console.warn('[cluster_metrics] ERROR ' + s);
        postToParent({ t: 'log', level: 'error', s });
    },
    debug() {},
};

process.on('uncaughtException', (err) => {
    benchLogger.error('uncaught exception: ' + ((err && err.stack) || err));
    process.exit(1);
});

const ipcDir = path.join(dataRoot, 'ipc');
fs.mkdirSync(ipcDir, { recursive: true });
process.env.CLUSTER_INFO_DIR = ipcDir;
process.env.CLUSTER_METRICS_BENCH = '1';

const { headUnit } = require(path.join(VENDOR_TOOLS, 'hu-stub.js'));
const hu = headUnit(stageDir, { live: true, dataDir: dataRoot, log: benchLogger, image: () => Promise.resolve() });

const origUiText = hu.ui.text;
hu.ui.text = (compName, value, row, cell) => {
    if (compName === 'STATUS' && !row) postToParent({ t: 'status', s: String(value) });
    return origUiText(compName, value, row, cell);
};

function publishSettings() {
    postToParent({
        t: 'settings',
        schema: hu.spec.settings,
        values: Object.assign({}, hu.settings.values),
    });
}
hu.settings.onChange(publishSettings);

function applyBenchSetting(key, val) {
    const meta = hu.settings.item(key);
    if (!meta) return benchLogger.warn('unknown setting key: ' + key);
    const widget = hu.ui.comp('SET_' + key.toUpperCase());
    if (meta.type === 'bool') {
        if (Boolean(hu.settings.get(key)) !== Boolean(val)) widget.emit('action', {});
        return;
    }
    const candidates = meta.type === 'choice' ? meta.options.map((opt) => opt[0]) : meta.steps;
    const idx = candidates.indexOf(val);
    if (idx < 0) return benchLogger.warn('invalid value for ' + key + ': ' + JSON.stringify(val));
    widget.emit('action', { row: idx });
}

const { DemoGenerator, computeFrictionBrake } = require(path.join(stageDir, 'source', 'javascript', 'signals.js'));
const demoSource = new DemoGenerator();

const ENCODE = {
    rpm: [0.25, 0],
    speed: [0.015625, 0],
    accel: [0.002, -65],
    temp: [1, -48],
    boost: [0.01, 0],
    battTemp: [1, -50],
    pedal: [0.025, 0],
    torque: [0.5, -1023.5],
};
const encodeSignal = (k, physical) => Math.round((physical - ENCODE[k][1]) / ENCODE[k][0]);

let simMode = 'demo';
let manualState = {
    speed: 68, rpm: 0, gear: 5, stage: 'D', program: 'D',
    hvKw: 14.2, soc: 68, battTemp: 23.5, oil: 48, coolant: 73,
    boost: 0, gLong: 0.02, pedalPct: 18, driverBraking: false, absActive: false,
    torqueNm: 0, massKg: 2100, brakeBar: null, tyreFlBar: 2.4,
};
let fuelCounterRaw = 10000;
let tickStep = 0;

function readNum(key, fallback) {
    const v = manualState[key];
    return typeof v === 'number' && isFinite(v) ? v : fallback;
}

function pushManualSignals() {
    const gear = Math.round(readNum('gear', 5));
    const rpm = readNum('rpm', 0);
    const speed = readNum('speed', 0);
    if (rpm > 350) fuelCounterRaw += Math.round(rpm * 0.12);

    hu.feed('de.bmw.infotainment.vehicle.CDS', 'statusEngineSpeed2', { actualValueRPMEngineCrankshaft: encodeSignal('rpm', rpm) });
    hu.feed('de.bmw.infotainment.vehicle.CDS', 'statusEngineTemperature', {
        temperatureEngineDrive: encodeSignal('temp', readNum('coolant', 75)),
        temperatureEngineOilDrive: encodeSignal('temp', readNum('oil', 55)),
    });
    hu.feed('de.bmw.infotainment.vehicle.CDS2', 'statusInjectionVolume', {
        injectionVolumeFuelEngine: fuelCounterRaw,
        oilTemperature: encodeSignal('temp', readNum('oil', 55)),
    });
    hu.feed('de.bmw.infotainment.vehicle.CDS2', 'statusLongitudinalAccelerationMassCenter', {
        longitudinalAccelerationCentreOfGravity: encodeSignal('accel', readNum('gLong', 0.02) * 9.80665),
    });
    hu.feed('de.bmw.infotainment.vehicle.Vehicle2', 'statusCarSpeed2', { speedVehicleCentreOfGravity: encodeSignal('speed', speed) });
    hu.feed('de.bmw.infotainment.vehicle.Vehicle2', 'statusVehicleMass', { massVehicle: Math.round(readNum('massKg', 2100)) });
    hu.feed('de.bmw.infrastructure.VehicleInformation', 'statusGearboxDrive', {
        statusActualGearDrive: gear > 0 ? 'G' + gear : 'N_OR_P',
        statusActualStageDrive: manualState.stage || 'D',
    });
    hu.feed('de.bmw.infotainment.misc.MDrive', 'dataDisplayGearbox', {
        displayProgramGearbox: manualState.program === 'S' ? 'S_MINUS_PROGRAMM' : manualState.program === 'M' ? 'M_MINUS_PROGRAMM' : 'D_PROGRAMM',
    });
    hu.feed('de.bmw.infotainment.drivingexcitement.Efficiencytainment2', 'statusBatteryTemperature', {
        actualValueTemperatureHighVoltageStorage: encodeSignal('battTemp', readNum('battTemp', 23.5)),
    });
    hu.feed('de.bmw.infotainment.drivingexcitement.FES', 'statusSwitchDriveDynamicSport2', {
        displayBoostPressure: encodeSignal('boost', Math.max(0, readNum('boost', 0))),
    });
    hu.feed('de.bmw.infotainment.drivingexcitement.FES', 'statusFESVehicleDynamicSwitchHMI', {
        actualValueModeDrivingExperience: manualState.program === 'S' ? 1 : 4,
    });
    hu.feed('de.bmw.infotainment.drivingexcitement.FES', 'statusActualValueTorque2', {
        actualValueTorqueCrankshaft: encodeSignal('torque', readNum('torqueNm', rpm > 350 ? 120 : 0)),
    });
    hu.feed('de.bmw.chassis.VehicleStabilizationManagement', 'StabilizationManagement', {
        statusBrakingDriver: manualState.driverBraking ? 1 : 0,
        qualifierFunctionABS: manualState.absActive ? 1 : 0,
    });
    hu.feed('de.bmw.powertrain.AcceleratorPedal', 'AngleAcceleratorPedal', {
        actualValueAngleAcceleratorPedal: encodeSignal('pedal', readNum('pedalPct', 18)),
    });
    const flBar = readNum('tyreFlBar', 2.4);
    hu.feed('de.bmw.infotainment.vehicle.TPMS', 'statusTyrePressure', {
        actualValuePressureTyreFLH: Math.round(flBar * 10),
        actualValuePressureTyreFRH: 24,
        actualValuePressureTyreRLH: 26,
        actualValuePressureTyreRRH: 26,
    });
    hu.feed('de.bmw.infotainment.vehicle.TPMS', 'statusTargetTyrePressure', {
        targetPressureTyreFLH: 24, targetPressureTyreFRH: 24, targetPressureTyreRLH: 26, targetPressureTyreRRH: 26,
    });

    const edriveIpc = {
        t: Date.now(),
        app: 'edrive_bench',
        power: { kw: readNum('hvKw', 12), old: false },
        values: { soc: { pct: readNum('soc', 68) }, battery: { c: readNum('battTemp', 23.5) } },
    };
    if (typeof manualState.brakeBar === 'number' && isFinite(manualState.brakeBar)) {
        edriveIpc.brake = { bar: manualState.brakeBar };
    }
    fs.writeFileSync(path.join(ipcDir, 'edrive.json'), JSON.stringify(edriveIpc));
}

function publishTelemetrySnapshot() {
    if (simMode === 'manual') {
        const gear = Math.round(readNum('gear', 5));
        const rpm = readNum('rpm', 0);
        const speedKmh = readNum('speed', 0);
        const hvKw = readNum('hvKw', 14.2);
        const fb = computeFrictionBrake({
            speedKmh,
            rpm,
            gear,
            hvKw,
            gLong: readNum('gLong', 0.02),
            pedalPct: readNum('pedalPct', 18),
            driverBraking: Boolean(manualState.driverBraking),
            absActive: Boolean(manualState.absActive),
            torqueNm: readNum('torqueNm', rpm > 350 ? 120 : 0),
            massKg: readNum('massKg', 2100),
            brakeBar: typeof manualState.brakeBar === 'number' ? manualState.brakeBar : null,
        });
        const vehPref = hu.settings.get('vehicle') || 'auto';
        const isEv = vehPref === 'ice' ? false : rpm < 450;
        postToParent({
            t: 'telemetry',
            v: {
                mode: 'manual',
                speedKmh,
                rpm,
                gear,
                stage: manualState.stage || 'D',
                program: manualState.program || 'D',
                hvKw,
                soc: readNum('soc', 68),
                battTempC: readNum('battTemp', 23.5),
                oilTempC: readNum('oil', 48),
                coolantTempC: readNum('coolant', 73),
                boostBar: readNum('boost', 0),
                gLong: readNum('gLong', 0.02),
                pedalPct: readNum('pedalPct', 18),
                driverBraking: Boolean(manualState.driverBraking),
                absActive: Boolean(manualState.absActive),
                frictionG: fb.frictionG,
                frictionKw: fb.frictionKw,
                pureRegen: fb.pureRegen,
                erangeKm: 31,
                frangeKm: 410,
                ambientC: 21.5,
                driveMode: manualState.program === 'S' ? 'sport' : 'comfort',
                isEv,
            },
        });
    } else {
        const simPref = hu.settings.get('demo') || 'auto';
        const vehPref = hu.settings.get('vehicle') || 'auto';
        const simKind = simPref === 'ice' ? 'ice' : (simPref === 'phev' ? 'phev' : (vehPref === 'ice' ? 'ice' : 'phev'));
        const sample = demoSource.sample(simKind, Date.now());
        postToParent({
            t: 'telemetry',
            v: Object.assign({ mode: 'demo', simKind, isEv: simKind === 'phev' && (sample.rpm || 0) < 450 }, sample),
        });
    }
}

setInterval(() => {
    tickStep++;
    if (simMode === 'manual') pushManualSignals();
    if (tickStep % 2 === 0) publishTelemetrySnapshot();
}, 100);

process.on('message', (msg) => {
    if (!msg) return;
    if (msg.t === 'signals') {
        simMode = msg.mode === 'manual' ? 'manual' : 'demo';
        manualState = Object.assign({}, manualState, msg.values || {});
        if (hu.settings.get('demo') !== (simMode === 'manual' ? 'off' : 'auto')) {
            applyBenchSetting('demo', simMode === 'manual' ? 'off' : 'auto');
        }
    } else if (msg.t === 'set') {
        applyBenchSetting(msg.key, msg.value);
    }
});

const exitNow = () => process.exit(0);
process.on('disconnect', exitNow);
process.on('SIGTERM', exitNow);

hu.start();
publishSettings();
benchLogger.info('bench runner active (' + path.relative(process.cwd(), stageDir) + ')');
