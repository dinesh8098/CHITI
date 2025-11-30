// --- SECURITY: CLEAR SESSION ON LOAD ---
// This ensures that if they hit "Back" to get here, they are logged out.
// --- FORCE RESET ON PAGE LOAD (Handles Back Button) ---
window.addEventListener('pageshow', (event) => {
    // 1. Always clear the session to force re-login
    localStorage.removeItem('activeUser');

    // 2. Reset all form inputs (clear typed text)
    const forms = document.querySelectorAll('form');
    forms.forEach(form => form.reset());

    // 3. Reset the UI View back to "Step 1"
    const loginStep1 = document.getElementById('login-step-1');
    const loginStep2 = document.getElementById('login-step-2');
    const msg1 = document.getElementById('login-message-1');
    const msg2 = document.getElementById('login-message-2');
    const nextBtn = document.getElementById('next-step-btn');

    if (loginStep1 && loginStep2) {
        loginStep1.style.display = 'flex'; // Show Email/Pass
        loginStep2.style.display = 'none'; // Hide Passkey
    }

    // 4. Reset Messages and Buttons
    if (msg1) msg1.textContent = "";
    if (msg2) msg2.textContent = "";
    if (nextBtn) {
        nextBtn.textContent = "Next Step";
        nextBtn.disabled = false;
    }
});

// --- FORCE LOGOUT ON PAGE LOAD/BACK BUTTON ---
window.addEventListener('pageshow', () => {
    // This ensures the session is destroyed the moment they hit "Back"
    localStorage.removeItem('activeUser');
});

// --- IMPORT FIREBASE ---
import { initializeApp } from 'firebase/app';
import { getFirestore, collection, addDoc, query, where, getDocs } from 'firebase/firestore';

// --- CONFIGURATION ---
const firebaseConfig = {
    apiKey: "AIzaSyAdyeqEvElVM8PCT_TgxsbSW9S8KidGqC0",
    authDomain: "humanoid-chiti.firebaseapp.com",
    projectId: "humanoid-chiti",
    storageBucket: "humanoid-chiti.firebasestorage.app",
    messagingSenderId: "434846085044",
    appId: "1:434846085044:web:414f0facbaff9afa4c4ce1",
    measurementId: "G-HV50CDBEQ9"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

// --- GLOBAL VARIABLES (Critical for sharing data) ---
let currentUser = null; // <--- THIS WAS MISSING OR SCOPED WRONG

// --- ANIMATION LOGIC ---
const signUpButton = document.getElementById('signUp');
const signInButton = document.getElementById('signIn');
const container = document.getElementById('container');

if (signUpButton && signInButton) {
    signUpButton.addEventListener('click', () => container.classList.add("right-panel-active"));
    signInButton.addEventListener('click', () => container.classList.remove("right-panel-active"));
}

// --- UTILITY: Get User IP ---
async function getIpAddress() {
    try {
        const response = await fetch('https://api.ipify.org?format=json');
        const data = await response.json();
        return data.ip;
    } catch (error) {
        console.error("IP Fetch Error:", error);
        return "Unknown IP";
    }
}

// --- LOGIC 1: REGISTRATION ---
const regForm = document.getElementById('registerForm');
if (regForm) {
    regForm.addEventListener('submit', async function(e) {
        e.preventDefault();
        const btn = document.getElementById('signup-btn');
        const messageBox = document.getElementById('reg-message');

        btn.textContent = "Registering...";
        btn.disabled = true;

        const name = document.getElementById('reg-name').value;
        const email = document.getElementById('reg-email').value;
        const password = document.getElementById('reg-pass').value;
        const passkey = document.getElementById('reg-passkey').value;

        try {
            // 1. Fetch IP
            const registeredIp = await getIpAddress();

            // 2. Check if user exists
            const q = query(collection(db, "users"), where("email", "==", email));
            const querySnapshot = await getDocs(q);

            if (!querySnapshot.empty) {
                messageBox.style.color = "#ef4444";
                messageBox.textContent = "User already exists!";
                btn.textContent = "Sign Up";
                btn.disabled = false;
                return;
            }

            // 3. Save to Firestore
            await addDoc(collection(db, "users"), {
                name: name,
                email: email,
                password: password,
                passkey: passkey,
                ip: registeredIp,
                createdAt: new Date().toISOString()
            });

            // 4. Success
            messageBox.style.color = "#10b981";
            messageBox.textContent = `Registered IP: ${registeredIp}`;

            setTimeout(() => {
                container.classList.remove("right-panel-active");
                messageBox.textContent = "";
                btn.textContent = "Sign Up & Save IP";
                btn.disabled = false;
                e.target.reset();
            }, 2000);

        } catch (error) {
            console.error("Registration Error:", error);
            messageBox.style.color = "#ef4444";
            messageBox.textContent = "Error connecting to cloud.";
            btn.disabled = false;
        }
    });
}

// --- LOGIC 2: LOGIN STEP 1 (Credentials) ---
const nextBtn = document.getElementById('next-step-btn');

if (nextBtn) {
    nextBtn.addEventListener('click', async function() {
        // Inputs
        const email = document.getElementById('login-email').value;
        const password = document.getElementById('login-pass').value;
        const messageBox = document.getElementById('login-message-1');

        // Containers (Defined inside to ensure they exist)
        const loginStep1 = document.getElementById('login-step-1');
        const loginStep2 = document.getElementById('login-step-2');
        const ipStatusMsg = document.getElementById('ip-status-msg');

        if (!loginStep1 || !loginStep2) {
            console.error("CRITICAL: Missing login containers in HTML.");
            return;
        }

        messageBox.textContent = "";
        nextBtn.textContent = "Verifying...";
        nextBtn.disabled = true;

        try {
            const q = query(collection(db, "users"), where("email", "==", email), where("password", "==", password));
            const querySnapshot = await getDocs(q);

            if (!querySnapshot.empty) {
                // User Found - SAVE TO GLOBAL VARIABLE
                const userDoc = querySnapshot.docs[0];
                currentUser = userDoc.data();

                // Switch View
                loginStep1.style.display = "none";
                loginStep2.style.display = "flex"; // Changed to flex for alignment

                // Verify IP
                const displayRegIp = document.getElementById('display-reg-ip');
                const displayCurrIp = document.getElementById('display-curr-ip');

                if (displayRegIp) displayRegIp.textContent = currentUser.ip;

                const currentIp = await getIpAddress();
                if (displayCurrIp) displayCurrIp.textContent = currentIp;

                if (ipStatusMsg) {
                    if (currentIp !== currentUser.ip) {
                        ipStatusMsg.style.color = "#ef4444";
                        ipStatusMsg.textContent = "Warning: Unrecognized IP Address!";
                        if (displayCurrIp) displayCurrIp.style.color = "#ef4444";
                    } else {
                        ipStatusMsg.style.color = "#10b981";
                        ipStatusMsg.textContent = "Network Verified (Secure)";
                        if (displayCurrIp) displayCurrIp.style.color = "#10b981";
                    }
                }
            } else {
                messageBox.style.color = "#ef4444";
                messageBox.textContent = "Invalid credentials.";
            }
        } catch (error) {
            console.error("Login Error:", error);
            messageBox.textContent = "Cloud connection failed.";
        }

        nextBtn.textContent = "Next Step";
        nextBtn.disabled = false;
    });
}

// --- LOGIC 3: LOGIN STEP 2 (Passkey) ---
// --- LOGIC 3: LOGIN STEP 2 (Passkey & IP Check) ---
const loginForm = document.getElementById('loginForm');

if (loginForm) {
    // IMPORTANT: Added 'async' here so we can check IP one last time
    loginForm.addEventListener('submit', async function(e) {
        e.preventDefault();

        const enteredPasskey = document.getElementById('passkey-input').value;
        const robotCheck = document.getElementById('robot-check').checked;
        const messageBox = document.getElementById('login-message-2');

        // 1. Robot Verification
        if (!robotCheck) {
            messageBox.style.color = "#ef4444";
            messageBox.textContent = "Human verification required.";
            return;
        }

        // 2. IP SECURITY LOCK (The New Feature)
        // We fetch the IP again to be absolutely sure
        messageBox.style.color = "#ef4444"; // Default to red for errors
        messageBox.textContent = "Verifying Security Protocols...";

        const currentIp = await getIpAddress();

        if (currentUser.ip !== currentIp) {
            // IP MISMATCH - BLOCK ACCESS
            messageBox.textContent = `CRITICAL: IP Address Mismatch! Registered: ${currentUser.ip} vs Current: ${currentIp}`;
            return; // STOP THE SCRIPT HERE. DO NOT ALLOW LOGIN.
        }

        // 3. Passkey Verification (Only runs if IP matches)
        if (currentUser && enteredPasskey === currentUser.passkey) {
            messageBox.style.color = "#10b981";
            messageBox.textContent = "Identity Verified. Access Granted.";

            // Save Session
            localStorage.setItem('activeUser', JSON.stringify(currentUser));

            // Redirect
            // Redirect
            setTimeout(() => {
                // USE HREF to keep history, so "Back" button works
                window.location.href = "dashboard/dashboard.html";
            }, 1000);
        } else {
            messageBox.textContent = "Incorrect Security Passkey.";
        }
    });
}

// Back Button
const backBtn = document.getElementById('back-btn');
if (backBtn) {
    backBtn.addEventListener('click', () => {
        const loginStep1 = document.getElementById('login-step-1');
        const loginStep2 = document.getElementById('login-step-2');

        if (loginStep1 && loginStep2) {
            loginStep2.style.display = "none";
            loginStep1.style.display = "flex"; // Changed to flex to keep layout
            document.getElementById('passkey-input').value = "";
            document.getElementById('login-message-2').textContent = "";
        }
    });
}