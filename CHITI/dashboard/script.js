// --- AUTH GUARD (Place at line 1) ---
const activeSession = localStorage.getItem('activeUser');

if (!activeSession) {
    // If no user is found, force redirect to Login
    alert("Restricted Access: Please Login First");
    window.location.href = "/index.html";
}


import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, onAuthStateChanged } from 'firebase/auth';
import { getFirestore, collection, addDoc, getDocs, query } from 'firebase/firestore';

// --- CONFIGURATION ---
const SETTINGS = {
    walkSpeed: 3.5,
    runSpeed: 7.0,
    turnSpeed: 3.0,
    baseLat: 37.7749,
    baseLon: -122.4194,
    hasRealGPS: false,
    jointSpeed: 2.0,
    recordInterval: 2.0,
    packetRate: 0.25,
    idleMultiplier: 1.0,
    walkMultiplier: 1.0,
    chargeRate: 15.0
};

const BINDINGS = {
    forward: 'w',
    backward: 's',
    left: 'a',
    right: 'd',
    emergency: 'e',
    run: 'shift',
    shoulderUp: 't',
    shoulderDown: 'g',
    armUp: 'y',
    armDown: 'h',
    forearmUp: 'u',
    forearmDown: 'j',
    handUp: 'i',
    handDown: 'k'
};

// --- FIREBASE SETUP ---
let app, auth, db;
let isCloudActive = false;

let firebaseConfig;
try {
    if (typeof __firebase_config !== 'undefined') {
        firebaseConfig = JSON.parse(__firebase_config);
        isCloudActive = true;
    } else if (window.firebaseConfig) {
        firebaseConfig = window.firebaseConfig;
        isCloudActive = true;
    }

    if (isCloudActive && firebaseConfig) {
        app = initializeApp(firebaseConfig);

        db = getFirestore(app);
    } else {
        console.warn("Running in Offline Mode: Firebase config not found.");
    }
} catch (e) {
    console.warn("Cloud init skipped:", e);
}

const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id';
let userId = null;

// --- GLOBAL STATE ---
let scene, camera, renderer, clock;
let robot, mixer, skeletonHelper;
let actions = {},
    activeAction = null;
let map, robotMarker, currentPathPolyline;
let isPoweredOn = true;
let battery = 100;
let currentSpeed = 0;
let bones = { shoulder: null, arm: null, forearm: null, hand: null };
let jointOffsets = { shoulder: 0, arm: 0, forearm: -0.3, hand: 0 };
const pressedKeys = {};

// Analytics & Logs
let runHistory = [];
let packetLog = [];
let lastPacketTime = 0;
let fleetCycles = 0,
    fleetDist = 0;
let sessionDist = 0,
    sessionStartTime = Date.now(),
    sessionStartBat = 100;
let lastPauseTime = 0;

// Buffers
let telemetryBuffer = [];
let lastRecordTime = 0;

// Monitor Simulation Vars
let sysTemp = 40.0,
    sysAmps = 0.5,
    sysVolts = 24.0;
let cyclesPendingUpload = 0,
    cycleLatch = false;

// Charts
let barChart, lineChart;

// --- INITIALIZATION ---
document.addEventListener('DOMContentLoaded', () => {
    init();
    animate();
});

function init() {
    initMap();
    initCharts();
    setupKeys();
    if (isCloudActive) initCloud();
    initThreeJS();
    setupUIListeners();

    // Telemetry Interval
    setInterval(() => {
        if (isPoweredOn && sessionDist > 10) flushTelemetry('AUTO');
    }, 15000);
}

function setupUIListeners() {
    // Power Button Logic
    const btnPower = document.getElementById('btn-power');
    if (btnPower) {
        btnPower.onclick = () => {
            isPoweredOn = !isPoweredOn;
            const statusVal = document.getElementById('status-val');
            const cloudStatus = document.getElementById('cloud-status');

            if (isPoweredOn) {
                btnPower.innerText = "SYSTEM POWER: ON";
                btnPower.className = "action-btn btn-success";
                if (statusVal) {
                    statusVal.innerText = "ONLINE";
                    statusVal.style.color = "var(--success-color)";
                }
                if (cloudStatus && isCloudActive) {
                    cloudStatus.innerText = "CONNECTED";
                    cloudStatus.classList.add('active');
                }

                if (actions['Idle']) fadeToAction('Idle', 1.0);

                // Resume Logic
                const pauseDuration = Date.now() - lastPauseTime;
                sessionStartTime += pauseDuration;
                // Important: Reset session start battery to current level when turning ON
                sessionStartBat = battery;
            } else {
                btnPower.innerText = "SYSTEM POWER: OFF";
                btnPower.className = "action-btn btn-danger";
                if (statusVal) {
                    statusVal.innerText = "OFFLINE";
                    statusVal.style.color = "var(--danger-color)";
                }
                if (cloudStatus) {
                    cloudStatus.innerText = "OFFLINE";
                    cloudStatus.classList.remove('active');
                }

                lastPauseTime = Date.now();
                // FIX: When powered off, zero out all joint offsets to stop rotation
                jointOffsets = { shoulder: 0, arm: 0, forearm: 0, hand: 0 };

                flushTelemetry('POWER_OFF');
            }
        };
    }

    // Log Download
    const btnExport = document.getElementById('btn-download');
    if (btnExport) {
        btnExport.onclick = function() {
            const blob = new Blob([JSON.stringify(packetLog, null, 2)], { type: "application/json" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `robot_log_${Date.now()}.json`;
            a.click();
        }
    }

    // Tab Switching
    window.openTab = function(tabId) {
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));

        const targetBtn = document.querySelector(`.tab-btn[onclick="window.openTab('${tabId}')"]`);
        if (targetBtn) targetBtn.classList.add('active');

        const targetPane = document.getElementById('tab-' + tabId);
        if (targetPane) targetPane.classList.add('active');

        // Refresh charts if monitoring is opened to fix canvas sizing
        if (tabId === 'monitoring') setTimeout(initCharts, 100);
    }

    // Update Checker
    window.checkForUpdates = function() {
        const btn = document.getElementById('btn-check-update');
        const msg = document.getElementById('update-msg');
        const progWrap = document.getElementById('update-progress-wrap');

        btn.disabled = true;
        btn.innerText = "CONNECTING...";
        msg.innerText = "Contacting secure update server...";
        msg.style.color = "#00ffcc";

        setTimeout(() => {
            msg.innerText = "New Firmware v2.5.0 Available (12MB)";
            btn.innerText = "DOWNLOAD & INSTALL";
            btn.disabled = false;
            btn.onclick = () => {
                btn.style.display = 'none';
                progWrap.style.display = 'block';
                msg.innerText = "Installing Firmware...";
                let p = 0;
                const interval = setInterval(() => {
                    p += 2;
                    document.getElementById('update-progress').style.width = p + '%';
                    if (p >= 100) {
                        clearInterval(interval);
                        msg.innerText = "Update Complete. Rebooting...";
                        msg.style.color = "#10b981";
                        setTimeout(() => location.reload(), 1500);
                    }
                }, 50);
            };
        }, 1500);
    }

    // Sliders
    const idleSlider = document.getElementById('idle-slider');
    if (idleSlider) idleSlider.addEventListener('input', (e) => {
        SETTINGS.idleMultiplier = parseFloat(e.target.value);
        const val = document.getElementById('idle-val');
        if (val) val.innerText = SETTINGS.idleMultiplier.toFixed(1) + "x";
    });

    const walkSlider = document.getElementById('walk-slider');
    if (walkSlider) walkSlider.addEventListener('input', (e) => {
        SETTINGS.walkMultiplier = parseFloat(e.target.value);
        const val = document.getElementById('walk-val');
        if (val) val.innerText = SETTINGS.walkMultiplier.toFixed(1) + "x";
    });
}

// --- THREE.JS ENGINE ---
function initThreeJS() {
    scene = new THREE.Scene();

    camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 100);
    camera.position.set(1.5, 2.5, 4.0);
    camera.lookAt(0, 1, 0);

    // Lighting
    const hemiLight = new THREE.HemisphereLight(0xffffff, 0x444444, 1.0);
    scene.add(hemiLight);
    const dirLight = new THREE.DirectionalLight(0xffffff, 1.5);
    dirLight.position.set(5, 10, 7);
    scene.add(dirLight);
    const spot = new THREE.SpotLight(0x38bdf8, 5);
    spot.position.set(-5, 5, 5);
    scene.add(spot);

    // Floor
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(100, 100), new THREE.MeshStandardMaterial({ color: 0x1e293b }));
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    scene.add(floor);
    scene.add(new THREE.GridHelper(100, 20, 0x334155, 0x0f172a));

    // Robot Model
    const loader = new GLTFLoader();
    loader.load('https://cdn.jsdelivr.net/gh/mrdoob/three.js@r147/examples/models/gltf/Xbot.glb', (gltf) => {
        robot = gltf.scene;
        robot.scale.set(1.5, 1.5, 1.5);

        robot.traverse(c => {
            if (c.isMesh) {
                c.castShadow = true;
                c.receiveShadow = true;
                if (c.material) {
                    c.material.metalness = 0.6;
                    c.material.roughness = 0.4;
                }
            }
            if (c.isBone) {
                if (c.name.includes('RightShoulder')) bones.shoulder = c;
                else if (c.name.includes('RightForeArm')) bones.forearm = c;
                else if (c.name.includes('RightArm')) bones.arm = c;
                else if (c.name.includes('RightHand')) bones.hand = c;
            }
        });

        skeletonHelper = new THREE.SkeletonHelper(robot);
        skeletonHelper.visible = false;
        scene.add(skeletonHelper);
        scene.add(robot);

        mixer = new THREE.AnimationMixer(robot);
        actions['Idle'] = mixer.clipAction(gltf.animations.find(c => c.name === 'idle'));
        actions['Walk'] = mixer.clipAction(gltf.animations.find(c => c.name === 'walk'));
        actions['Run'] = mixer.clipAction(gltf.animations.find(c => c.name === 'run'));
        actions['Idle'].play();
        activeAction = actions['Idle'];
    }, undefined, (error) => {
        console.error("Error loading robot model", error);
        const geo = new THREE.BoxGeometry(1, 2, 0.5);
        const mat = new THREE.MeshStandardMaterial({ color: 0x38bdf8 });
        robot = new THREE.Mesh(geo, mat);
        robot.position.y = 1;
        scene.add(robot);
    });

    const canvas = document.getElementById('webgl-canvas');
    renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, alpha: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;

    clock = new THREE.Clock();
    window.addEventListener('resize', () => {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
    });
}

// --- INPUT HANDLING ---
function setupKeys() {
    window.addEventListener('keydown', (e) => {
        const k = e.key.toLowerCase();
        pressedKeys[k] = true;
        const el = document.getElementById('key-' + k);
        if (el) el.classList.add('pressed');
    });
    window.addEventListener('keyup', (e) => {
        const k = e.key.toLowerCase();
        pressedKeys[k] = false;
        const el = document.getElementById('key-' + k);
        if (el) el.classList.remove('pressed');
    });
}

// --- MAP SYSTEM ---
function initMap() {
    if (typeof L === 'undefined') return;

    map = L.map('mini-map', { zoomControl: false, attributionControl: false }).setView([SETTINGS.baseLat, SETTINGS.baseLon], 15);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', { maxZoom: 19 }).addTo(map);

    const robotIcon = L.divIcon({
        className: 'robot-marker',
        html: '<div style="width:12px; height:12px; background:#38bdf8; border-radius:50%; box-shadow:0 0 10px #38bdf8; border:2px solid white;"></div>',
        iconSize: [12, 12]
    });
    robotMarker = L.marker([SETTINGS.baseLat, SETTINGS.baseLon], { icon: robotIcon }).addTo(map);
    currentPathPolyline = L.polyline([], { color: '#38bdf8', weight: 3, opacity: 0.7 }).addTo(map);

    // GPS Logic
    const gpsEl = document.getElementById('gps-val');
    if (gpsEl) {
        gpsEl.innerText = "SEARCH";
        gpsEl.style.color = "yellow";
    }

    if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
            (pos) => {
                SETTINGS.baseLat = pos.coords.latitude;
                SETTINGS.baseLon = pos.coords.longitude;
                SETTINGS.hasRealGPS = true;

                const userPos = [SETTINGS.baseLat, SETTINGS.baseLon];
                if (map) map.setView(userPos, 18);
                if (robotMarker) robotMarker.setLatLng(userPos);

                if (gpsEl) {
                    gpsEl.innerText = "LIVE";
                    gpsEl.style.color = "#10b981";
                }
            },
            (err) => {
                console.warn("GPS Error:", err);
                if (gpsEl) {
                    gpsEl.innerText = "ERR";
                    gpsEl.style.color = "#ef4444";
                }
            }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
        );
    }
}

// --- CHARTS SYSTEM ---
function initCharts() {
    const commonOptions = {
        responsive: true,
        maintainAspectRatio: false,
        scales: { y: { beginAtZero: true, grid: { color: 'rgba(255,255,255,0.05)' } }, x: { grid: { display: false } } },
        plugins: { legend: { display: false } }
    };

    // Destroy existing charts to avoid duplicates
    if (barChart) barChart.destroy();
    if (lineChart) lineChart.destroy();

    // Bar Chart
    const barCanvas = document.getElementById('chartDistance');
    if (barCanvas) {
        const barCtx = barCanvas.getContext('2d');
        barChart = new Chart(barCtx, {
            type: 'bar',
            data: { labels: [], datasets: [{ label: 'Distance (m)', data: [], backgroundColor: '#38bdf8', borderRadius: 4 }] },
            options: commonOptions
        });
    }

    // Line Chart
    const lineCanvas = document.getElementById('chartEfficiency');
    if (lineCanvas) {
        const lineCtx = lineCanvas.getContext('2d');
        lineChart = new Chart(lineCtx, {
            type: 'line',
            data: { labels: [], datasets: [{ label: 'Eff (m/%)', data: [], borderColor: '#10b981', backgroundColor: 'rgba(16, 185, 129, 0.1)', fill: true, tension: 0.4 }] },
            options: commonOptions
        });
    }
}

function updateCharts() {
    if (!barChart || !lineChart) return;
    const labels = runHistory.map((_, i) => `Run ${i+1}`);

    barChart.data.labels = labels;
    barChart.data.datasets[0].data = runHistory.map(r => r.dist);
    barChart.update();

    if (lineChart) {
        lineChart.data.labels = labels;
        lineChart.data.datasets[0].data = runHistory.map(r => {
            const used = parseFloat(r.batUsed) || 1;
            return used > 0 ? (r.dist / used).toFixed(1) : 0;
        });
        lineChart.update();
    }
}

function fadeToAction(name, duration) {
    const nextAction = actions[name];
    if (!nextAction || !activeAction) return;
    if (activeAction === nextAction) return;

    if (activeAction) {
        activeAction.fadeOut(duration);
    }

    activeAction = nextAction;
    activeAction.reset().fadeIn(duration).play();
}

function updateLogic(dt) {
    // Determine charging status immediately
    let isCharging = pressedKeys['e'];
    let drain = 0;

    // --- BATTERY CALCULATION FLOW ---
    if (isCharging) {
        drain = -SETTINGS.chargeRate; // Charging (negative drain)
    } else if (isPoweredOn) {
        if (Math.abs(currentSpeed) > 0.1) {
            drain = 0.10 * SETTINGS.walkMultiplier;
            if (Math.abs(currentSpeed) > 4) drain *= 2;
        } else {
            drain = 0.05 * SETTINGS.idleMultiplier;
        }
    } else {
        drain = 0;
    }

    // Apply change to battery
    battery -= drain * dt;
    battery = Math.min(100, Math.max(0, battery));

    // --- FIX: AUTO-RECOVERY LOGIC ---
    // Previously, this checked !isCharging, which kept the alert on while charging.
    // Now, we simply check if battery is safe (> 0.1).
    if (battery > 0.1) {
        const alertOverlay = document.getElementById('alert-overlay');
        if (alertOverlay) alertOverlay.style.display = 'none';
    }

    // 3. Critical Drain Check (Alert if battery drops to 0)
    if (battery < 0.01) {
        battery = 0;
        if (isPoweredOn) {
            isPoweredOn = false;
            togglePower(false); // Force UI update

            const alertOverlay = document.getElementById('alert-overlay');
            if (alertOverlay) alertOverlay.style.display = 'block';

            flushTelemetry('DEAD');
            currentSpeed = 0;
        }
    }

    // 4. Cycle Count Logic
    if (battery >= 99.9 && !cycleLatch) {
        cyclesPendingUpload++;
        cycleLatch = true;
        flushTelemetry('CHARGED');
    } else if (battery < 90) {
        cycleLatch = false;
    }

    // --- UI UPDATES ---
    if (document.getElementById('val-speed')) document.getElementById('val-speed').innerText = Math.abs(currentSpeed).toFixed(2) + " m/s";
    if (document.getElementById('battery-fill')) document.getElementById('battery-fill').style.width = battery + "%";
    if (document.getElementById('battery-label')) document.getElementById('battery-label').innerText = Math.floor(battery) + "%";

    if (document.getElementById('val-dist')) document.getElementById('val-dist').innerText = (fleetDist + sessionDist).toFixed(0) + " m";
    if (document.getElementById('val-cycles')) document.getElementById('val-cycles').innerText = (fleetCycles + cyclesPendingUpload);

    // --- PACKET GENERATION ---
    const isInteracting = pressedKeys['w'] || pressedKeys['s'] || pressedKeys['a'] || pressedKeys['d'] ||
        pressedKeys['t'] || pressedKeys['g'] || pressedKeys['y'] || pressedKeys['h'] ||
        pressedKeys['u'] || pressedKeys['j'] || pressedKeys['i'] || pressedKeys['k'] ||
        isCharging;

    const currentRate = isInteracting ? 0.1 : SETTINGS.packetRate;

    if (clock.getElapsedTime() - lastPacketTime > currentRate) {
        lastPacketTime = clock.getElapsedTime();

        let jointData = {};
        if (bones.shoulder) {
            jointData = {
                shoulder: bones.shoulder.rotation.z.toFixed(2),
                arm: bones.arm.rotation.x.toFixed(2),
                elbow: bones.forearm.rotation.x.toFixed(2),
                hand: bones.hand.rotation.z.toFixed(2)
            };
        }

        const packet = {
            seq: packetLog.length,
            t: Date.now(),
            bat: battery.toFixed(1),
            vel: currentSpeed.toFixed(2),
            pose: { x: robot.position.x.toFixed(2), z: robot.position.z.toFixed(2) },
            status: isPoweredOn ? "RUNNING" : (isCharging ? "CHARGING" : "OFFLINE"),
            joints: jointData
        };
        packetLog.push(packet);
        if (packetLog.length > 50) packetLog.shift();

        const display = document.getElementById('packet-display');
        if (display) display.innerText = JSON.stringify(packet, null, 2).replace(/[{}]/g, '');
    }

    // --- MOVEMENT ---
    if (!robot || !isPoweredOn) {
        currentSpeed = 0;
        return;
    }

    let speed = 0;
    if (pressedKeys['w']) speed = 3.5;
    if (pressedKeys['s']) speed = -2.0;
    if (pressedKeys['shift']) speed *= 2.0;

    currentSpeed = THREE.MathUtils.lerp(currentSpeed, speed, dt * 5);
    if (pressedKeys['a']) robot.rotation.y += 2.0 * dt;
    if (pressedKeys['d']) robot.rotation.y -= 2.0 * dt;

    robot.translateZ(currentSpeed * dt);

    const newPos = [0, 0];
    if (Math.abs(currentSpeed) > 0.1) {
        const dist = currentSpeed * dt;
        sessionDist += Math.abs(dist);

        const latOffset = robot.position.z / 111111;
        const lonOffset = robot.position.x / (111111 * Math.cos(SETTINGS.baseLat * Math.PI / 180));
        newPos[0] = SETTINGS.baseLat + latOffset;
        newPos[1] = SETTINGS.baseLon + lonOffset;

        if (robotMarker) {
            robotMarker.setLatLng(newPos);
            map.panTo(newPos);
            currentPathPolyline.addLatLng(newPos);
        }

        if (clock.getElapsedTime() - lastRecordTime > SETTINGS.recordInterval) {
            telemetryBuffer.push({ lat: newPos[0], lon: newPos[1], bat: battery, spd: currentSpeed });
            lastRecordTime = clock.getElapsedTime();
        }
    }

    // Camera Follow
    const offset = new THREE.Vector3(1.8, 2.5, 4.0);
    offset.applyAxisAngle(new THREE.Vector3(0, 1, 0), robot.rotation.y);
    camera.position.lerp(robot.position.clone().add(offset), 0.1);
    const lookAt = new THREE.Vector3(-1.2, 1.5, 0);
    lookAt.applyAxisAngle(new THREE.Vector3(0, 1, 0), robot.rotation.y);
    camera.lookAt(robot.position.clone().add(lookAt));

    // Diagnostics Sim
    let load = Math.abs(currentSpeed) * 8 + 12;
    sysTemp = THREE.MathUtils.lerp(sysTemp, 45 + (load / 5), dt);
    if (document.getElementById('mon-cpu')) document.getElementById('mon-cpu').innerText = Math.floor(load) + "%";
    if (document.getElementById('mon-volt')) document.getElementById('mon-volt').innerText = (24.1 - (load / 200)).toFixed(1) + "V";
    if (document.getElementById('mon-temp')) document.getElementById('mon-temp').innerText = sysTemp.toFixed(1) + "°C";
    if (document.getElementById('mon-ping')) document.getElementById('mon-ping').innerText = Math.floor(Math.random() * 10 + 20) + "ms";

    // Animation
    const action = Math.abs(currentSpeed) > 0.1 ? (Math.abs(currentSpeed) > 4 ? 'Run' : 'Walk') : 'Idle';
    fadeToAction(action, 0.2);

    // Kinematics UI
    if (bones.shoulder) {
        if (document.getElementById('kin-s')) document.getElementById('kin-s').innerText = bones.shoulder.rotation.z.toFixed(2);
        if (document.getElementById('kin-a')) document.getElementById('kin-a').innerText = bones.arm.rotation.x.toFixed(2);
        if (document.getElementById('kin-e')) document.getElementById('kin-e').innerText = bones.forearm.rotation.x.toFixed(2);
        if (document.getElementById('kin-w')) document.getElementById('kin-w').innerText = bones.hand.rotation.z.toFixed(2);
        if (document.getElementById('ee-x')) {
            const pos = new THREE.Vector3();
            bones.hand.getWorldPosition(pos);
            document.getElementById('ee-x').innerText = pos.x.toFixed(2);
            document.getElementById('ee-y').innerText = pos.y.toFixed(2);
            document.getElementById('ee-z').innerText = pos.z.toFixed(2);
        }
    }
}

function updateJoints(dt) {
    if (!bones.shoulder || !isPoweredOn) return;
    const speed = 2.0 * dt;
    if (pressedKeys['t']) jointOffsets.shoulder += speed;
    if (pressedKeys['g']) jointOffsets.shoulder -= speed;
    if (pressedKeys['y']) jointOffsets.arm -= speed;
    if (pressedKeys['h']) jointOffsets.arm += speed;
    if (pressedKeys['u']) jointOffsets.forearm -= speed;
    if (pressedKeys['j']) jointOffsets.forearm += speed;
    if (pressedKeys['i']) jointOffsets.hand += speed;
    if (pressedKeys['k']) jointOffsets.hand -= speed;

    bones.shoulder.rotation.z += jointOffsets.shoulder;
    bones.arm.rotation.x += jointOffsets.arm;
    bones.forearm.rotation.x += jointOffsets.forearm;
    bones.hand.rotation.z += jointOffsets.hand;
}

// --- CLOUD ---
async function initCloud() {
    if (!auth) return;
    onAuthStateChanged(auth, async(user) => {
        if (user) {
            userId = user.uid;
            await loadHistory();
        } else {
            signInAnonymously(auth).catch(e => console.log("Offline mode"));
        }
    });
}

async function loadHistory() {
    if (!userId || !db) return;
    try {
        const colRef = collection(db, 'artifacts', appId, 'public', 'data', 'robot_telemetry');
        const snapshot = await getDocs(colRef);
        runHistory = [];
        let totalCycles = 0;

        snapshot.forEach(doc => {
            const d = doc.data();
            if (d.stats && d.stats.distance > 5) {
                runHistory.push({ dist: Math.floor(d.stats.distance), batUsed: parseFloat(d.stats.batConsumed || 0) });
                totalCycles += (d.stats.cycles || 0);
            }
        });

        fleetCycles = totalCycles;
        if (document.getElementById('val-cycles')) document.getElementById('val-cycles').innerText = fleetCycles;

        if (runHistory.length > 10) runHistory = runHistory.slice(-10);
        updateCharts();
    } catch (e) {
        // Silent catch for permissions
    }
}

async function flushTelemetry(reason) {
    if (!db || !activeUser) {
        // Only alert once to prevent spam
        if (!window.hasAlertedDB) {
            //alert("Error: Database connection lost. Data not saving.");
            window.hasAlertedDB = true;
        }
        return;
    }

    const totalCurrentDist = fleetDist + sessionDist;

    let jointData = {};
    if (bones.shoulder) {
        jointData = {
            s: bones.shoulder.rotation.z.toFixed(2),
            a: bones.arm.rotation.x.toFixed(2),
            e: bones.forearm.rotation.x.toFixed(2),
            h: bones.hand.rotation.z.toFixed(2)
        };
    }

    const payload = {
        userEmail: activeUser.email,
        timestamp: Date.now(),
        reason: reason,

        battery: parseFloat(battery.toFixed(2)),
        totalCycles: fleetCycles + cyclesPendingUpload,
        totalDistance: parseFloat(totalCurrentDist.toFixed(1)),
        sessionDistance: parseFloat(sessionDist.toFixed(1)),
        velocity: parseFloat(currentSpeed.toFixed(2)),

        sys: { temp: sysTemp.toFixed(1), volt: sysVolts.toFixed(1) },
        joints: jointData,
        path: telemetryBuffer.slice(-20),
        history: runHistory
    };

    if (sessionDist > 5 && reason !== "AUTO") {
        runHistory.push({ dist: Math.floor(sessionDist), batUsed: 0 });
        if (runHistory.length > 10) runHistory.shift();
        payload.history = runHistory;
        updateCharts();
    }

    try {
        await addDoc(collection(db, "telemetry"), payload);
        console.log("Cloud Save:", reason);

        if (reason !== "AUTO") {
            fleetDist += sessionDist;
            sessionDist = 0;
            telemetryBuffer = [];
        }
    } catch (e) {
        console.error("Save failed:", e);
    }
}

function animate() {
    requestAnimationFrame(animate);
    const dt = clock.getDelta();
    if (mixer && isPoweredOn) mixer.update(dt);
    updateLogic(dt);
    updateJoints(dt);
    renderer.render(scene, camera);
}

// Add this at the VERY END of dashboard/script.js
window.flushTelemetry = flushTelemetry;