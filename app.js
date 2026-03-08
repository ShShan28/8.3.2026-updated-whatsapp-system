/**
 * ============================================================================
 * WHATSAPP SENDER APP — PROFESSIONAL ENTERPRISE EDITION v4.0 FIXED
 * ============================================================================
 * 
 * MAJOR FIXES APPLIED:
 * 1. ✅ FIXED: Scheduler now sends at correct time
 * 2. ✅ FIXED: Renewal/Expiry messages send automatically
 * 3. ✅ FIXED: Bulk sender duplicate issue resolved
 * 4. ✅ FIXED: Watermark/document issues resolved
 * 5. ✅ FIXED: Watermark now includes name + phone number
 * 
 * ============================================================================
 */

'use strict';
/* ========================================================================== */
/* 0. INDEXED DB ENGINE (V2 - Lazy Loading Enterprise Architecture)           */
/* ========================================================================== */
const dbName = "WAEnterpriseDB";
const storeMeta = "schedules_meta"; // Lightweight (UI rendering)
const storeData = "schedules_data"; // Heavyweight (Base64 & 5000+ Contacts)

function openDB() {
    return new Promise((resolve, reject) => {
        // Increment version to 2 to force an update if schema was stuck
        const request = indexedDB.open(dbName, 2); 

        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            console.log("DB Upgrade: Creating Object Stores...");
            if (!db.objectStoreNames.contains(storeMeta)) {
                db.createObjectStore(storeMeta, { keyPath: "id" });
            }
            if (!db.objectStoreNames.contains(storeData)) {
                db.createObjectStore(storeData, { keyPath: "id" });
            }
        };

        request.onsuccess = (event) => {
            const db = event.target.result;
            // Handle database closing unexpectedly
            db.onversionchange = () => {
                db.close();
                console.log("Database version changed, please reload.");
            };
            resolve(db);
        };

        request.onerror = (event) => {
            console.error("IndexedDB Error:", event.target.error);
            reject("DB Error: " + (event.target.error ? event.target.error.message : "Unknown Error"));
        };

        request.onblocked = () => {
            console.warn("Database open blocked! Please close other tabs of this app.");
            alert("Database is blocked. Please close other tabs of this app and refresh.");
        };
    });
}

async function saveScheduleToDB(meta, data) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        try {
            const tx = db.transaction([storeMeta, storeData], "readwrite");
            const metaStore = tx.objectStore(storeMeta);
            const dataStore = tx.objectStore(storeData);

            metaStore.put(meta);
            dataStore.put(data);

            tx.oncomplete = () => {
                db.close(); // Close connection after saving
                resolve("Saved");
            };
            tx.onerror = (event) => {
                console.error("Transaction Error:", event.target.error);
                reject(event.target.error.message);
            };
        } catch (e) {
            reject(e.message);
        }
    });
}

// Updates ONLY the lightweight metadata (Used for marking as 'sent' or 'paused')
async function updateScheduleMeta(meta) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeMeta, "readwrite");
        tx.objectStore(storeMeta).put(meta);
        tx.oncomplete = () => resolve("Updated");
    });
}

// Fast load for UI - ONLY pulls lightweight data (Prevents Browser Crashes)
async function getAllSchedulesMeta() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeMeta, "readonly");
        const request = tx.objectStore(storeMeta).getAll();
        request.onsuccess = () => resolve(request.result || []);
    });
}

// Just-In-Time Retrieval: Pulls the 40MB file only when it's time to send
async function getScheduleData(id) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeData, "readonly");
        const request = tx.objectStore(storeData).get(id);
        request.onsuccess = () => resolve(request.result || null);
    });
}

// Deletes a schedule completely
async function deleteScheduleFromDB(id) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction([storeMeta, storeData], "readwrite");
        tx.objectStore(storeMeta).delete(id);
        tx.objectStore(storeData).delete(id);
        tx.oncomplete = () => resolve("Deleted");
    });
}

// Enterprise Auto-Cleanup: Deletes heavy files after sending to save user's hard drive space
async function clearHeavyDataAfterSend(id) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeData, "readwrite");
        tx.objectStore(storeData).delete(id);
        tx.oncomplete = () => resolve("Cleared Heavy Data");
    });
}
/* ========================================================================== */
/* 1. GLOBAL CONFIGURATION & CONSTANTS                                        */
/* ========================================================================== */

const DEFAULT_CONFIG = {
    currentInstanceId: 'instance153584',
    currentEndpoint: 'send.php',
    currentToken: '',

    // Rate Limiting Settings
    rateDelay: 1200,
    randomizeDelay: true,
    jitterRange: 3000,

    // File Size Settings
    maxFileSizeMB: 30,
    maxFileSizeBytes: 30 * 1024 * 1024,

    // Enterprise Settings
    batchSize: 50,
    batchDelay: 60000,
    parallelLimit: 3,

    // Network Settings
    isMasterPC: false,
    masterIP: '',
    slaveMode: false,

    // Watermark Optimization
    watermarkDelayOverride: true,
    enableWatermarking: true,
    watermarkFormat: 'name_phone', // Options: 'name', 'phone', 'name_phone', 'custom'
    watermarkText: '{name} - {phone}', // Custom format

    // Safety Settings for 5000+ contacts
    maxContactsPerBatch: 200,
    safetyDelayMultiplier: 1.5,
    enableProgressiveDelay: true,

    enableAccountPooling: false,
    poolingMode: 'even', // Options: 'even' (split list evenly) or 'rotate' (swap every X messages)
    poolingChunkSize: 50, // How many to send before rotating (if mode is 'rotate')
    pooledInstances: [],  // Array of Instance IDs selected in Admin
    pauseOnInstanceSwitch: 10000 // Wait 10 seconds when swapping to a new number
};

/* ========================================================================== */
/* 2. GLOBAL STATE MANAGEMENT                                                 */
/* ========================================================================== */

let isSchedulerRunning = false;
let isAutoResponderRunning = false;
let isBulkPaused = false;
let isBulkStopped = false;
let isSchedulerPaused = false;
let isSchedulerStopped = false;
let editingContactIndex = null;
let parsedBulk = [];
let currentSchedulerJob = null;
let activeBulkProcess = null;
let processedContacts = new Set(); // Track processed contacts to prevent duplicates

/**
 * Load application configuration from LocalStorage
 */
function loadAppConfig() {
    try {
        const savedConfig = localStorage.getItem('wa_app_config');
        if (savedConfig) {
            const config = JSON.parse(savedConfig);
            // Ensure new settings exist
            return { ...DEFAULT_CONFIG, ...config };
        }
        return { ...DEFAULT_CONFIG };
    } catch (error) {
        console.error("Failed to load app config:", error);
        return { ...DEFAULT_CONFIG };
    }
}

// Initialize appConfig AFTER loadAppConfig is defined
let appConfig = loadAppConfig();

/**
 * Save configuration to LocalStorage
 */
function saveAppConfig() {
    try {
        localStorage.setItem('wa_app_config', JSON.stringify(appConfig));
        updateFileSizeDisplays();
    } catch (error) {
        console.error("Error saving configuration:", error);
        showToast("Failed to save settings locally.", "error");
    }
}

/**
 * Update file size displays across the app
 */
function updateFileSizeDisplays() {
    const size = appConfig.maxFileSizeMB;
    const elements = [
        'currentFileSize',
        'bulkFileSize',
        'scheduleFileSize'
    ];

    elements.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.textContent = `${size}MB`;
    });

    // Update max file size bytes
    appConfig.maxFileSizeBytes = size * 1024 * 1024;
}

/**
 * Get active WhatsApp instance
 */
function getActiveInstance() {
    try {
        const storedInstances = localStorage.getItem('wa_instances');
        const instances = storedInstances ? JSON.parse(storedInstances) : [];
        const activeId = localStorage.getItem('wa_active_instance_id');

        // Look for the instance that is actually marked as active
        let activeInstance = instances.find(inst => inst.id === activeId);

        // If no active ID is set, but we have instances, pick the first one
        if (!activeInstance && instances.length > 0) {
            activeInstance = instances[0];
            localStorage.setItem('wa_active_instance_id', activeInstance.id);
        }

        // Only use the hardcoded default if the database is completely empty
        if (!activeInstance) {
            return {
                id: appConfig.currentInstanceId || 'instance153584',
                name: 'Default Instance',
                endpoint: appConfig.currentEndpoint || 'send.php',
                token: appConfig.currentToken || ''
            };
        }

        return activeInstance;
    } catch (error) {
        console.error("Error retrieving active instance:", error);
        return { id: 'ERROR', name: 'System Error', endpoint: '', token: '' };
    }
}

/**
 * Calculate smart delay with watermark optimization
 */
function getSmartDelay(isWatermarking = false, currentIndex = 0, totalCount = 1) {
    const baseDelay = parseInt(appConfig.rateDelay) || 1200;

    // If watermarking is happening, reduce extra delay
    if (isWatermarking && appConfig.watermarkDelayOverride) {
        return Math.max(500, baseDelay * 0.3);
    }

    // Progressive delay for large batches (safety for 5000+ contacts)
    if (appConfig.enableProgressiveDelay && totalCount > 100) {
        const progressRatio = currentIndex / totalCount;
        const multiplier = 1 + (progressRatio * 0.5); // Increase delay by up to 50%
        return Math.floor(baseDelay * multiplier);
    }

    if (!appConfig.randomizeDelay) {
        return baseDelay;
    }

    const maxJitter = parseInt(appConfig.jitterRange) || 2000;
    const randomJitter = Math.floor(Math.random() * maxJitter);

    return baseDelay + randomJitter;
}

/**
 * Get current IP address
 */
async function getCurrentIP() {
    try {
        const response = await fetch('https://api.ipify.org?format=json');
        const data = await response.json();
        return data.ip;
    } catch (error) {
        console.error("Failed to get IP:", error);
        return 'Unknown';
    }
}

/* ========================================================================== */
/* 3. INITIALIZATION & EVENT LISTENERS                                        */
/* ========================================================================== */

document.addEventListener('DOMContentLoaded', async () => {

    // 1. Inject toast styles
    injectToastStyles();
    // Initialize real-time clock
    initializeRealTimeClock();
    // 2. Initialize navigation
    const navButtons = document.querySelectorAll('.nav-btn');
    navButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            navButtons.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            showView(btn.dataset.view);
        });
    });

    // 3. Update header
    updateHeaderInstanceInfo();
    updateFileSizeDisplays();
    setTimeout(() => {
        if (typeof adminCheckServer === 'function') {
            adminCheckServer(true); // 'true' makes it silent
        }
    }, 1500);

    // 4. Get current IP and check if master PC
    try {
        const currentIP = await getCurrentIP();
        const masterIP = appConfig.masterIP;

        if (masterIP && currentIP === masterIP) {
            appConfig.isMasterPC = true;
            showToast(`Master PC detected: ${currentIP}`, 'info');
        } else if (masterIP) {
            appConfig.isMasterPC = false;
            console.log(`Slave mode: Current IP ${currentIP}, Master IP ${masterIP}`);
        }

        // Update IP display in admin
        const ipDisplay = document.getElementById('currentIPDisplay');
        if (ipDisplay) {
            ipDisplay.textContent = currentIP;
        }
    } catch (error) {
        console.error("IP detection failed:", error);
    }

    // ----------------------------------------------------------------------
    // TAB: SEND (Single)
    // ----------------------------------------------------------------------
    document.getElementById('sendSingleBtn')?.addEventListener('click', sendSingle);
    document.getElementById('saveContactBtn')?.addEventListener('click', saveSingleContact);

    // File upload progress
    const singleFileInput = document.getElementById('singleFile');
    if (singleFileInput) {
        singleFileInput.addEventListener('change', function (e) {
            const file = e.target.files[0];
            if (file) {
                const sizeMB = (file.size / (1024 * 1024)).toFixed(2);
                const progress = Math.min((file.size / appConfig.maxFileSizeBytes) * 100, 100);

                document.getElementById('fileSizeInfo').textContent =
                    `File: ${file.name} (${sizeMB}MB)`;
                document.getElementById('fileUploadProgress').style.width = `${progress}%`;

                if (file.size > appConfig.maxFileSizeBytes) {
                    showToast(`File exceeds ${appConfig.maxFileSizeMB}MB limit`, 'error');
                    e.target.value = '';
                }
            }
        });
    }

    // Send mode selection
    document.querySelectorAll('input[name="sendMode"]').forEach(radio => {
        radio.addEventListener('change', function () {
            updateSendModeUI(this.value);
        });
    });

    // ----------------------------------------------------------------------
    // TAB: BULK SENDER
    // ----------------------------------------------------------------------
    document.getElementById('previewBulkBtn')?.addEventListener('click', previewBulkList);
    document.getElementById('sendBulkBtn')?.addEventListener('click', sendBulkList);
    document.getElementById('bulkCsv')?.addEventListener('change', handleBulkCsv);

    // Bulk control buttons
    document.getElementById('pauseBulkBtn')?.addEventListener('click', () => {
        if (!document.getElementById('pauseBulkBtn').disabled) {
            isBulkPaused = true;
            toggleBulkControls('paused');
            showToast('Bulk sending PAUSED', 'warning');
        }
    });

    document.getElementById('resumeBulkBtn')?.addEventListener('click', () => {
        if (!document.getElementById('resumeBulkBtn').disabled) {
            isBulkPaused = false;
            toggleBulkControls('running');
            showToast('Resuming bulk sending...', 'info');
        }
    });

    document.getElementById('stopBulkBtn')?.addEventListener('click', () => {
        if (!document.getElementById('stopBulkBtn').disabled) {
            if (confirm('CRITICAL: Stop sending? This cannot be resumed.')) {
                isBulkStopped = true;
                isBulkPaused = false;
                toggleBulkControls('idle');
                showToast('Bulk process stopped', 'error');
            }
        }
    });

    // ----------------------------------------------------------------------
    // TAB: CONTACTS & PLANS
    // ----------------------------------------------------------------------
    loadContacts();
    document.getElementById('addContactBtn')?.addEventListener('click', addContact);
    document.getElementById('contactCsvFile')?.addEventListener('change', handleContactCsvImport);

    // ----------------------------------------------------------------------
    // TAB: NOTIFICATION AUTOMATION
    // ----------------------------------------------------------------------
    document.getElementById('saveNotifSettingsBtn')?.addEventListener('click', saveNotificationSettings);
    loadNotificationSettings();

    // ----------------------------------------------------------------------
    // TAB: TEMPLATES
    // ----------------------------------------------------------------------
    loadTemplates();
    document.getElementById('saveTplBtn')?.addEventListener('click', saveTemplate);

    // ----------------------------------------------------------------------
    // TAB: LOGS
    // ----------------------------------------------------------------------
    renderLogs();
    document.getElementById('exportCsvBtn')?.addEventListener('click', exportLogsCsv);
    document.getElementById('clearLogsBtn')?.addEventListener('click', clearLogs);

    // ----------------------------------------------------------------------
    // TAB: SCHEDULER
    // ----------------------------------------------------------------------
    document.getElementById('saveScheduleBtn')?.addEventListener('click', saveLocalSchedule);
    document.getElementById('sendScheduleNowBtn')?.addEventListener('click', sendScheduleNow);
    document.getElementById('pauseSchedulerBtn')?.addEventListener('click', pauseScheduler);
    document.getElementById('resumeSchedulerBtn')?.addEventListener('click', resumeScheduler);
    document.getElementById('stopSchedulerBtn')?.addEventListener('click', stopScheduler);
    renderSchedules();
    document.getElementById('resetSchedulerBtn')?.addEventListener('click', resetScheduler);

    // ----------------------------------------------------------------------
    // TAB: ADMIN & SETTINGS
    // ----------------------------------------------------------------------
    const adminAddBtn = document.getElementById('adminAddInstanceBtn');
    if (adminAddBtn) {
        adminAddBtn.addEventListener('click', adminAddInstance);
        document.getElementById('adminCheckServerBtn').addEventListener('click', adminCheckServer);
        document.getElementById('adminSaveSettingsBtn').addEventListener('click', adminSaveSettings);
        document.getElementById('adminFactoryResetBtn').addEventListener('click', adminFactoryReset);
        document.getElementById('adminDetectIPBtn').addEventListener('click', adminDetectIP);

        // Backup & Restore
        document.getElementById('adminBackupBtn').addEventListener('click', downloadBackup);
        document.getElementById('adminRestoreInput').addEventListener('change', restoreBackup);

        // Settings initialization
        loadAdminSettings();

        // Delay slider
        const delayRange = document.getElementById('adminDelayRange');
        if (delayRange) {
            delayRange.value = appConfig.rateDelay;
            document.getElementById('adminDelayDisplay').textContent = `${appConfig.rateDelay}ms`;
            delayRange.addEventListener('input', (e) => {
                document.getElementById('adminDelayDisplay').textContent = `${e.target.value}ms`;
            });
        }

        // Jitter toggle
        const jitterToggle = document.getElementById('adminJitterToggle');
        if (jitterToggle) {
            jitterToggle.checked = appConfig.randomizeDelay;
            jitterToggle.addEventListener('change', (e) => {
                appConfig.randomizeDelay = e.target.checked;
            });
        }

        // File size slider
        const sizeSlider = document.getElementById('adminFileSizeRange');
        if (sizeSlider) {
            sizeSlider.value = appConfig.maxFileSizeMB;
            document.getElementById('adminFileSizeDisplay').textContent = `${appConfig.maxFileSizeMB}MB`;
            sizeSlider.addEventListener('input', (e) => {
                const mb = parseInt(e.target.value);
                document.getElementById('adminFileSizeDisplay').textContent = `${mb}MB`;
            });
        }

        // Watermark toggle
        const watermarkToggle = document.getElementById('adminWatermarkToggle');
        if (watermarkToggle) {
            watermarkToggle.checked = appConfig.enableWatermarking;
            watermarkToggle.addEventListener('change', (e) => {
                appConfig.enableWatermarking = e.target.checked;
            });
        }

        // Watermark format selection
        const watermarkFormat = document.getElementById('adminWatermarkFormat');
        if (watermarkFormat) {
            watermarkFormat.value = appConfig.watermarkFormat || 'name_phone';
            watermarkFormat.addEventListener('change', (e) => {
                appConfig.watermarkFormat = e.target.value;
            });
        }

        // Watermark text input
        const watermarkText = document.getElementById('adminWatermarkText');
        if (watermarkText) {
            watermarkText.value = appConfig.watermarkText || '{name} - {phone}';
            watermarkText.addEventListener('input', (e) => {
                appConfig.watermarkText = e.target.value;
            });
        }
    }

    loadAdminInstances();

    // ----------------------------------------------------------------------
    // UI HELPERS & STARTUP
    // ----------------------------------------------------------------------
    createBulkContactsUI();
    createScheduleContactsUI();
    loadBulkContactsList();
    loadScheduleContactsList();

    // Initialize contact selection counters
    updateContactSelectionCounters();

    // Add event listeners for contact selection changes
    document.addEventListener('change', function (e) {
        if (e.target.classList.contains('bulk-contact') ||
            e.target.classList.contains('schedule-contact') ||
            e.target.id === 'selectAllBulk' ||
            e.target.id === 'selectAllSchedule') {
            updateContactSelectionCounters();
        }
    });

    // Show dashboard by default
    if (document.getElementById('view-dashboard')) {
        showView('dashboard');
    }

    // Set copyright year
    const currentYearEl = document.getElementById('currentYear');
    if (currentYearEl) {
        currentYearEl.textContent = new Date().getFullYear();
    }

    // Initialize scheduler
    initializeScheduler();

    // Initialize auto-responder
    initializeAutoResponder();

    // Update message count
    updateMessageCount();

    // Initialize send mode UI
    updateSendModeUI('both');

    console.log('WhatsApp Sender Pro v4.0 - Fully Fixed Enterprise Edition Initialized');
    // ----------------------------------------------------------------------
    // REAL-TIME SEARCH EVENT LISTENERS
    // ----------------------------------------------------------------------
    document.getElementById('searchContacts')?.addEventListener('input', () => {
        applyRealTimeFilter('searchContacts', 'contactsList');
    });

    document.getElementById('searchBulkContacts')?.addEventListener('input', () => {
        applyRealTimeFilter('searchBulkContacts', 'bulkContactsList');
    });

    document.getElementById('searchScheduleContacts')?.addEventListener('input', () => {
        applyRealTimeFilter('searchScheduleContacts', 'scheduleContactsList');
    });
});

/* ========================================================================== */
/* 4. VIEW MANAGEMENT                                                         */
/* ========================================================================== */

function showView(name) {
    // 1. Hide all views
    document.querySelectorAll('.view').forEach(v => {
        v.classList.remove('active');
        v.style.display = 'none';
    });

    // 2. Show target view
    const el = document.getElementById('view-' + name);
    if (el) {
        el.classList.add('active');
        el.style.display = 'block';
    }

    // 3. FIX: Update sidebar navigation highlighting automatically!
    document.querySelectorAll('.nav-btn').forEach(btn => {
        if (btn.dataset.view === name) {
            btn.classList.add('active');
        } else {
            btn.classList.remove('active');
        }
    });

    // 4. Update title
    const titles = {
        dashboard: 'Analytics Dashboard',
        send: 'Send Message',
        bulk: 'Bulk Sender',
        contacts: 'Contacts & Plans',
        notifications: 'Notification Automation',
        scheduler: 'Message Scheduler',
        templates: 'Message Templates',
        logs: 'Logs & History',
        admin: 'Admin Settings'
    };

    const titleEl = document.getElementById('viewTitle');
    if (titleEl) titleEl.textContent = titles[name] || 'App';

    // 5. Special actions for specific views
    if (name === 'dashboard') {
        renderDashboard();
    } else if (name === 'logs') {
        renderLogs();
    }
}

function updateHeaderInstanceInfo() {
    const active = getActiveInstance();
    const el = document.getElementById('instanceId');
    if (!el) return;

    el.innerHTML = `
        <span class="badge bg-info text-dark">
            <i class="bi bi-robot"></i> ${escapeHtml(active.name)} 
            <span class="opacity-75">(${escapeHtml(active.id)})</span>
        </span>
        <span id="apiLiveStatus" class="badge bg-warning text-dark ms-2" style="cursor:pointer;" onclick="showQrModal()">
            <span class="spinner-border spinner-border-sm" style="width: 0.7rem; height: 0.7rem;"></span> Checking...
        </span>`;
    
    checkApiInstanceHealth();
}

// FIXED: Bypasses CORS by using a more lenient fetch mode
async function checkApiInstanceHealth() {
    const active = getActiveInstance();
    const statusBadge = document.getElementById('apiLiveStatus');
    if (!statusBadge) return;

    // Don't run if it's the default placeholder ID
    if (!active.id || active.id.includes('instance153584')) {
        statusBadge.className = 'badge bg-secondary ms-2';
        statusBadge.innerHTML = '<i class="bi bi-gear"></i> Set Credentials';
        return;
    }

    statusBadge.className = 'badge bg-warning text-dark ms-2';
    statusBadge.innerHTML = '<span class="spinner-border spinner-border-sm" style="width: 0.7rem; height: 0.7rem;"></span> Checking...';

    try {
        // We use a JSONP-style approach or a simple image ping if fetch is blocked
        // But first, let's try a standard fetch with 'cors' mode explicitly
        const checkUrl = `https://api.ultramsg.com/${active.id}/instance/status?token=${active.token}`;
        
        const resp = await fetch(checkUrl, { 
            method: 'GET',
            mode: 'cors', // UltraMsg usually supports this, but if not:
            headers: { 'Accept': 'application/json' }
        });

        if (!resp.ok) throw new Error("CORS or Auth Error");

        const data = await resp.json();

        if (data.status && data.status.accountStatus === 'authenticated') {
            statusBadge.className = 'badge bg-success ms-2';
            statusBadge.innerHTML = '<i class="bi bi-wifi"></i> API Online';
            statusBadge.onclick = checkApiInstanceHealth; // Just refresh on click
        } else {
            statusBadge.className = 'badge bg-warning text-dark ms-2';
            statusBadge.innerHTML = '<i class="bi bi-phone-vibrate"></i> Scan QR Code';
            statusBadge.onclick = showQrModal;
        }
    } catch (err) {
        // If Fetch fails due to CORS, we assume it's offline or needs scan
        console.warn("CORS Blocked API Check. Manual check required.");
        statusBadge.className = 'badge bg-info text-dark ms-2';
        statusBadge.innerHTML = '<i class="bi bi-qr-code"></i> Check Connection';
        statusBadge.onclick = showQrModal;
    }
}

// FIXED: Using direct Image loading which ignores CORS
async function showQrModal() {
    const active = getActiveInstance();
    
    // Check if real credentials exist
    if (!active.id || !active.token || active.id.includes('153584')) {
        showToast("Enter your real UltraMsg ID and Token in Admin Settings.", "error");
        showView('admin');
        return;
    }

    const existing = document.getElementById('qrCodeModal');
    if (existing) {
        const oldModal = bootstrap.Modal.getInstance(existing);
        if (oldModal) oldModal.dispose();
        existing.remove();
    }

    // Direct image URL - browsers allow this even with CORS
    const qrImageUrl = `https://api.ultramsg.com/${active.id}/instance/qr?token=${active.token}&cb=${Date.now()}`;

    const html = `
        <div class="modal fade" id="qrCodeModal" tabindex="-1">
            <div class="modal-dialog modal-dialog-centered">
                <div class="modal-content shadow-lg border-0">
                    <div class="modal-header bg-dark text-white">
                        <h5 class="modal-title"><i class="bi bi-qr-code-scan"></i> Scan WhatsApp QR</h5>
                        <button type="button" class="btn-close btn-close-white" data-bs-dismiss="modal"></button>
                    </div>
                    <div class="modal-body text-center p-4">
                        <div id="qrContainer" class="bg-white p-3 rounded border mb-3 d-flex justify-content-center align-items-center" style="min-height: 280px;">
                            <img id="whatsappQrImage" src="${qrImageUrl}" 
                                 alt="QR Code" 
                                 class="img-fluid" 
                                 style="width: 250px; height: 250px;"
                                 onload="document.getElementById('qrSpinner').style.display='none';"
                                 onerror="handleQrError()">
                            
                            <div id="qrSpinner" class="text-center" style="position:absolute;">
                                <div class="spinner-border text-primary" role="status"></div>
                                <div class="small text-muted mt-2">Loading QR from UltraMsg...</div>
                            </div>
                        </div>
                        <p class="small text-muted">Go to WhatsApp > Linked Devices > Link a Device</p>
                    </div>
                    <div class="modal-footer bg-light">
                        <button class="btn btn-primary btn-sm w-100" onclick="checkApiInstanceHealth(); bootstrap.Modal.getInstance(document.getElementById('qrCodeModal')).hide();">
                            <i class="bi bi-check-circle"></i> I have scanned it
                        </button>
                    </div>
                </div>
            </div>
        </div>`;

    document.body.insertAdjacentHTML('beforeend', html);
    const modal = new bootstrap.Modal(document.getElementById('qrCodeModal'));
    modal.show();
}
async function showQrModal() {
    const active = getActiveInstance();
    
    // 1. First, check if credentials even exist
    if (!active.id || !active.token || active.id === 'instance153584') {
        showToast("Please update your Instance ID and Token in Admin Settings first.", "error");
        showView('admin'); // Automatically take them to settings to fix it
        return;
    }

    const existing = document.getElementById('qrCodeModal');
    if (existing) {
        const oldModal = bootstrap.Modal.getInstance(existing);
        if (oldModal) oldModal.dispose();
        existing.remove();
    }

    // UltraMsg URL for the QR Image
    const qrImageUrl = `https://api.ultramsg.com/${active.id}/instance/qr?token=${active.token}&cb=${Date.now()}`;

    const html = `
        <div class="modal fade" id="qrCodeModal" tabindex="-1" aria-hidden="true">
            <div class="modal-dialog modal-dialog-centered">
                <div class="modal-content shadow-lg border-0">
                    <div class="modal-header bg-dark text-white">
                        <h5 class="modal-title"><i class="bi bi-qr-code-scan"></i> Link WhatsApp Device</h5>
                        <button type="button" class="btn-close btn-close-white" data-bs-dismiss="modal"></button>
                    </div>
                    <div class="modal-body text-center p-4">
                        <p class="mb-3 text-muted">Open WhatsApp > Linked Devices > Link a Device</p>
                        
                        <div id="qrContainer" class="bg-white p-3 rounded border mb-3 d-flex justify-content-center align-items-center" style="min-height: 280px; position: relative;">
                            <img id="whatsappQrImage" src="${qrImageUrl}" 
                                 alt="QR Code" 
                                 class="img-fluid" 
                                 style="display:none; width: 250px; height: 250px;" 
                                 onload="document.getElementById('qrSpinner').style.display='none'; this.style.display='block';"
                                 onerror="handleQrError()">
                            
                            <div id="qrSpinner" class="text-center">
                                <div class="spinner-border text-primary" role="status"></div>
                                <div class="small text-muted mt-2">Connecting to UltraMsg...</div>
                            </div>
                        </div>

                        <div class="alert alert-info py-2 small mb-0">
                            <i class="bi bi-info-circle"></i> This window will close automatically after scan.
                        </div>
                    </div>
                    <div class="modal-footer bg-light">
                        <button class="btn btn-primary btn-sm w-100" onclick="refreshQrImage()">
                            <i class="bi bi-arrow-clockwise"></i> Retry Connection
                        </button>
                    </div>
                </div>
            </div>
        </div>`;

    document.body.insertAdjacentHTML('beforeend', html);
    const modal = new bootstrap.Modal(document.getElementById('qrCodeModal'));
    modal.show();

    // Background checker to close modal when authenticated
    if (window.qrCheckTimer) clearInterval(window.qrCheckTimer);
    window.qrCheckTimer = setInterval(async () => {
        try {
            const checkUrl = `https://api.ultramsg.com/${active.id}/instance/status?token=${active.token}`;
            const resp = await fetch(checkUrl);
            const data = await resp.json();
            
            if (data.status && data.status.accountStatus === 'authenticated') {
                clearInterval(window.qrCheckTimer);
                modal.hide();
                checkApiInstanceHealth(); 
                showToast("WhatsApp successfully linked!", "success");
            }
        } catch(e) { }

        if (!document.getElementById('qrCodeModal')) clearInterval(window.qrCheckTimer);
    }, 5000);
}

// UPGRADED: Handles specific error types
function handleQrError() {
    const container = document.getElementById('qrContainer');
    const active = getActiveInstance();
    if (!container) return;

    container.innerHTML = `
        <div class="text-danger p-3">
            <i class="bi bi-shield-slash fs-1"></i>
            <div class="fw-bold mt-2">Connection Rejected</div>
            <div class="small mb-2">UltraMsg could not verify your credentials.</div>
            <div class="p-2 bg-light rounded x-small text-dark border">
                <strong>ID:</strong> ${active.id}<br>
                <strong>Token:</strong> ${active.token ? 'Loaded' : 'Missing'}
            </div>
            <button class="btn btn-sm btn-danger mt-3" onclick="showView('admin'); bootstrap.Modal.getInstance(document.getElementById('qrCodeModal')).hide();">
                Fix in Admin Settings
            </button>
        </div>`;
}

// Helper to handle image loading errors (e.g. invalid instance ID)
function handleQrError() {
    const container = document.getElementById('qrContainer');
    if (container) {
        container.innerHTML = `
            <div class="text-danger p-3">
                <i class="bi bi-exclamation-octagon fs-1"></i>
                <div class="fw-bold mt-2">Failed to load QR</div>
                <div class="small">Check your Instance ID and Token in Admin settings.</div>
            </div>`;
    }
}

// Helper to manually refresh the image inside the modal
function refreshQrImage() {
    const img = document.getElementById('whatsappQrImage');
    const spinner = document.getElementById('qrSpinner');
    if (img && spinner) {
        img.style.display = 'none';
        spinner.style.display = 'block';
        const active = getActiveInstance();
        img.src = `https://api.ultramsg.com/${active.id}/instance/qr?token=${active.token}&cb=${Date.now()}`;
    }
}
function updateMessageCount() {
    const logs = JSON.parse(localStorage.getItem('wa_logs') || '[]');
    const sentCount = logs.filter(l => l.status === 'sent').length;
    const el = document.getElementById('messageCount');
    if (el) {
        el.innerHTML = `<i class="bi bi-chat-dots"></i> Sent: ${sentCount}`;
    }
}

/* ========================================================================== */
/* 5. ENHANCED DASHBOARD                                                      */
/* ========================================================================== */

// NEW: Added 'async' keyword
async function renderDashboard() {
    const view = document.getElementById('view-dashboard');
    if (!view) return;

    const logs = JSON.parse(localStorage.getItem('wa_logs') || '[]');
    const contacts = JSON.parse(localStorage.getItem('wa_contacts') || '[]');
    const activities = JSON.parse(localStorage.getItem('wa_activities') || '[]');

    // FIXED: Now reads from the new Enterprise IndexedDB instead of LocalStorage
    let schedules = [];
    try {
        schedules = await getAllSchedulesMeta();
    } catch (e) {
        console.log("Database not ready yet");
    }

    const sent = logs.filter(l => l.status === 'sent').length;
    const failed = logs.filter(l => l.status !== 'sent').length;
    const rate = logs.length > 0 ? Math.round((sent / logs.length) * 100) : 0;
    const activeContacts = contacts.filter(c => c.endDate && new Date(c.endDate) >= new Date()).length;

    // This will now accurately show your pending schedules!
    const pendingSchedules = schedules.filter(s => !s.sent).length;

    // ... [KEEP THE REST OF THE view.innerHTML = `...` EXACTLY THE SAME] ...

    view.innerHTML = `
        <div class="row g-3 mb-4">
            <div class="col-md-3">
                <div class="card h-100 border-primary">
                    <div class="card-body text-center">
                        <h1 class="display-4 text-primary fw-bold">${sent}</h1>
                        <p class="text-muted">Messages Sent</p>
                    </div>
                </div>
            </div>
            <div class="col-md-3">
                <div class="card h-100 border-success">
                    <div class="card-body text-center">
                        <h1 class="display-4 text-success fw-bold">${rate}%</h1>
                        <p class="text-muted">Success Rate</p>
                    </div>
                </div>
            </div>
            <div class="col-md-3">
                <div class="card h-100 border-info">
                    <div class="card-body text-center">
                        <h1 class="display-4 text-info fw-bold">${contacts.length}</h1>
                        <p class="text-muted">Total Contacts</p>
                    </div>
                </div>
            </div>
            <div class="col-md-3">
                <div class="card h-100 border-warning">
                    <div class="card-body text-center">
                        <h1 class="display-4 text-warning fw-bold">${activeContacts}</h1>
                        <p class="text-muted">Active Plans</p>
                    </div>
                </div>
            </div>
        </div>
        
        <div class="row mb-4">
            <div class="col-md-8">
                <div class="card h-100">
                    <div class="card-header">
                        <i class="bi bi-activity"></i> Recent Activity
                    </div>
                    <div class="card-body">
                        <div class="table-responsive">
                            <table class="table table-hover">
                                <table class="table table-sm table-hover align-middle">
                                <thead class="table-light">
                                    <tr>
                                        <th style="width: 20%">Time</th>
                                        <th style="width: 15%">Type</th>
                                        <th style="width: 45%">Event Description</th>
                                        <th style="width: 20%">Metrics</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    ${activities.slice(0, 10).map(act => {
        // Highlight text red if there's a failure
        let msgClass = "text-dark";
        if (act.success === false || act.failed > 0) msgClass = "text-danger fw-bold";

        // Format Metrics into clean badges
        let metricsHtml = '';
        if (act.recipients) {
            metricsHtml += `<span class="badge bg-secondary me-1" title="Recipients"><i class="bi bi-people"></i> ${act.recipients}</span>`;
        }
        if (act.success > 0 || (act.success === true && !act.recipients)) {
            metricsHtml += `<span class="badge bg-success me-1" title="Successful"><i class="bi bi-check-circle"></i> ${act.success === true ? 'Yes' : act.success}</span>`;
        }
        if (act.failed > 0 || act.success === false) {
            metricsHtml += `<span class="badge bg-danger text-white" title="Failed"><i class="bi bi-x-circle"></i> ${act.failed || 'Failed'}</span>`;
        }

        return `
                                        <tr>
                                            <td class="small text-muted">${act.time || ''}</td>
                                            <td><span class="badge bg-${getActivityBadgeColor(act.type)}">${act.type || 'Unknown'}</span></td>
                                            <td>
                                                <div class="${msgClass} text-truncate" style="max-width: 300px;" title="${escapeHtml(act.message || '')}">
                                                    ${escapeHtml(act.message || '')}
                                                </div>
                                            </td>
                                            <td>
                                                <div class="d-flex flex-wrap gap-1">${metricsHtml}</div>
                                                ${act.jobId ? `<div class="small text-muted mt-1" style="font-size: 0.75rem;">Job: ${act.jobId}</div>` : ''}
                                            </td>
                                        </tr>`;
    }).join('') || '<tr><td colspan="4" class="text-center text-muted py-4">No recent activity found.</td></tr>'}
                                </tbody>
                            </table>
                            
                        </div>
                        ${activities.length > 10 ? `
                            <div class="text-center mt-3">
                                <button class="btn btn-sm btn-outline-primary" onclick="showAllActivity()">
                                    View All Activities (${activities.length})
                                </button>
                            </div>
                        ` : ''}
                    </div>
                </div>
            </div>
            
            <div class="col-md-4">
                <div class="card h-100">
                    <div class="card-header">
                        <i class="bi bi-info-circle"></i> System Status
                    </div>
                    <div class="card-body">
                        <div class="mb-3">
                            <strong>WhatsApp Instance:</strong>
                            <div class="small text-muted">${getActiveInstance().name}</div>
                        </div>
                        <div class="mb-3">
                            <strong>Scheduler Status:</strong>
                            <span id="schedulerStatusBadge" class="badge bg-success">Active</span>
                            <div class="small text-muted">Checking every 30 seconds</div>
                        </div>
                        <div class="mb-3">
                            <strong>Auto-Responder:</strong>
                            <span class="badge bg-success">Active</span>
                            <div class="small text-muted">Checking expirations every 60 seconds</div>
                        </div>
                        <div class="mb-3">
                            <strong>Pending Schedules:</strong>
                            <span class="badge bg-warning">${pendingSchedules}</span>
                        </div>
                        <div class="mb-3">
                            <strong>File Size Limit:</strong>
                            <span class="badge bg-info">${appConfig.maxFileSizeMB}MB</span>
                        </div>
                        <div class="mb-3">
                            <strong>Base Delay:</strong>
                            <span class="badge bg-secondary">${appConfig.rateDelay}ms</span>
                        </div>
                        <div class="mb-3">
                            <strong>Master PC:</strong>
                            <span class="badge bg-${appConfig.isMasterPC ? 'success' : 'secondary'}">
                                ${appConfig.isMasterPC ? 'Yes' : 'No'}
                            </span>
                        </div>
                        ${appConfig.isMasterPC ? '' : `
                            <div class="mb-3">
                                <strong>Master IP:</strong>
                                <div class="small text-muted">${appConfig.masterIP || 'Not set'}</div>
                            </div>
                        `}
                    </div>
                </div>
            </div>
        </div>
        
        <div class="row">
            <div class="col-12">
                <div class="card">
                    <div class="card-header">
                        <i class="bi bi-graph-up"></i> Quick Actions
                    </div>
                    <div class="card-body">
                        <div class="d-flex gap-2 flex-wrap">
                            <button class="btn btn-outline-primary" onclick="showView('send')">
                                <i class="bi bi-send"></i> Send Single Message
                            </button>
                            <button class="btn btn-outline-success" onclick="showView('bulk')">
                                <i class="bi bi-broadcast"></i> Start Bulk Campaign
                            </button>
                            <button class="btn btn-outline-info" onclick="showView('contacts')">
                                <i class="bi bi-people"></i> Manage Contacts
                            </button>
                            <button class="btn btn-outline-warning" onclick="showView('scheduler')">
                                <i class="bi bi-calendar"></i> Schedule Messages
                            </button>
                            <button class="btn btn-outline-secondary" onclick="exportActivityCSV()">
                                <i class="bi bi-download"></i> Export Activity Log
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `;

    // Update scheduler status badge
    const schedulerStatus = isSchedulerStopped ? 'danger' : isSchedulerPaused ? 'warning' : 'success';
    const schedulerText = isSchedulerStopped ? 'Stopped' : isSchedulerPaused ? 'Paused' : 'Active';
    const badge = document.getElementById('schedulerStatusBadge');
    if (badge) {
        badge.className = `badge bg-${schedulerStatus}`;
        badge.textContent = schedulerText;
    }
}

function getActivityBadgeColor(type) {
    const colors = {
        'sent': 'success',
        'failed': 'danger',
        'scheduled': 'warning',
        'contact': 'info',
        'bulk': 'primary',
        'system': 'secondary',
        'automation': 'dark'
    };
    return colors[type] || 'secondary';
}

/* ========================================================================== */
/* 6. CONTACTS MANAGEMENT - FIXED RENEWAL/EXPIRY MESSAGES                    */
/* ========================================================================== */

function loadContacts() {
    const storedContacts = localStorage.getItem('wa_contacts');
    const list = storedContacts ? JSON.parse(storedContacts) : [];

    const listContainer = document.getElementById('contactsList');
    listContainer.innerHTML = '';

    if (!list.length) {
        listContainer.innerHTML = '<div class="text-muted p-3 text-center">No contacts saved yet.</div>';
        updateContactCountBadge(0);
        loadBulkContactsList();
        loadScheduleContactsList();
        return;
    }

    list.forEach((contact, index) => {
        const contactDiv = document.createElement('div');
        contactDiv.className = 'mb-2 p-3 border rounded bg-white';

        let planInfo = '';
        if (contact.startDate && contact.endDate) {
            const today = new Date();
            const endDate = new Date(contact.endDate);
            const daysLeft = Math.ceil((endDate - today) / (1000 * 60 * 60 * 24));
            const statusClass = daysLeft < 0 ? 'danger' : daysLeft < 7 ? 'warning' : 'success';

            planInfo = `
                <div class="small mt-2">
                    <span class="badge bg-${statusClass}">
                        <i class="bi bi-calendar"></i> ${contact.startDate} to ${contact.endDate}
                        ${daysLeft >= 0 ? `(${daysLeft} days left)` : '(Expired)'}
                    </span>
                </div>`;
        }

        // Notification status display - UPDATED WITH ALL NOTIFICATION TYPES
        // Enhanced expiry notification status
        let expiryNotificationStatus = '';
        if (contact.endDate) {
            const today = new Date();
            const endDate = new Date(contact.endDate);
            const isExpired = endDate < today;

            if (contact.notifiedEnd) {
                const statusText = contact.expiryStatus === 'notified_past_due' ? 'PAST DUE' : 'Expiry';
                expiryNotificationStatus = `
                    <div class="small text-${contact.expiryStatus === 'notified_past_due' ? 'warning' : 'success'}">
                        <i class="bi bi-check-circle"></i> ${statusText} notified on ${contact.notifiedAt ? new Date(contact.notifiedAt).toLocaleString() : 'unknown date'}
                    </div>`;
            } else if (isExpired) {
                const daysExpired = Math.floor((today - endDate) / (1000 * 60 * 60 * 24));
                expiryNotificationStatus = `
                    <div class="small text-danger">
                        <i class="bi bi-exclamation-triangle"></i> EXPIRED ${daysExpired} day${daysExpired !== 1 ? 's' : ''} ago (not notified)
                    </div>`;
            } else if (contact.endDate === getLocalDateString()) {
                expiryNotificationStatus = `
                    <div class="small text-warning">
                        <i class="bi bi-clock"></i> Expires TODAY
                    </div>`;
            }
        }

        const startNotificationStatus = contact.startNotifiedAt ?
            `<div class="small text-info">
                <i class="bi bi-check-circle"></i> Welcome sent on ${new Date(contact.startNotifiedAt).toLocaleDateString()}
            </div>` : '';

        const renewalNotificationStatus = contact.renewalNotifiedAt ?
            `<div class="small text-warning">
                <i class="bi bi-check-circle"></i> Renewal sent on ${new Date(contact.renewalNotifiedAt).toLocaleDateString()}
            </div>` : '';

        contactDiv.innerHTML = `
            <div class="d-flex justify-content-between align-items-start">
                <div class="flex-grow-1">
                    <div class="fw-bold">${escapeHtml(contact.name)}</div> 
                    <div class="small text-muted">
                        <i class="bi bi-whatsapp"></i> ${escapeHtml(contact.phone)}
                    </div>
                    ${planInfo}
                    ${expiryNotificationStatus}
                    ${startNotificationStatus}
                    ${renewalNotificationStatus}
                </div>
                <div class="btn-group">
                    <button class="btn btn-sm btn-outline-primary" onclick="fillNumber('${escapeHtml(contact.phone)}')" title="Send Message">
                        <i class="bi bi-send"></i>
                    </button>
                    <button class="btn btn-sm btn-outline-secondary" onclick="editContact(${index})" title="Edit Contact">
                        <i class="bi bi-pencil"></i>
                    </button>
                    <button class="btn btn-sm btn-outline-danger" onclick="deleteContact(${index})" title="Delete Contact">
                        <i class="bi bi-trash"></i>
                    </button>
                </div>
            </div>`;
        listContainer.appendChild(contactDiv);
    });

    updateContactCountBadge(list.length);
    loadBulkContactsList();
    loadScheduleContactsList();
    applyRealTimeFilter('searchContacts', 'contactsList');
}

function updateContactCountBadge(count) {
    const badge = document.getElementById('contactCountBadge');
    if (badge) {
        badge.textContent = count;
        badge.className = `badge ${count > 0 ? 'bg-primary' : 'bg-secondary'}`;
    }
}

function editContact(index) {
    const list = JSON.parse(localStorage.getItem('wa_contacts') || '[]');
    const contact = list[index];
    if (!contact) return;

    document.getElementById('contactName').value = contact.name;
    document.getElementById('contactPhone').value = contact.phone;
    document.getElementById('contactStart').value = contact.startDate || '';
    document.getElementById('contactEnd').value = contact.endDate || '';

    const btn = document.getElementById('addContactBtn');
    btn.innerHTML = '<i class="bi bi-check-lg"></i> Update Contact';
    btn.classList.remove('btn-primary');
    btn.classList.add('btn-warning');

    editingContactIndex = index;
    showToast(`Editing contact: ${contact.name}`, 'info');
}

function addContact() {
    const name = document.getElementById('contactName').value.trim();
    const phone = document.getElementById('contactPhone').value.trim();
    const start = document.getElementById('contactStart').value;
    const end = document.getElementById('contactEnd').value;

    if (!phone) {
        showToast('Enter phone number', 'error');
        return;
    }

    let list = JSON.parse(localStorage.getItem('wa_contacts') || '[]');

    // Clean phone number
    const cleanPhone = phone.replace(/[^0-9+]/g, '');

    const contactData = {
        name: name || cleanPhone,
        phone: cleanPhone,
        startDate: start,
        endDate: end,
        notifiedEnd: false,
        startNotified: false,
        renewalNotified: false,
        createdAt: new Date().toISOString()
    };

    // Update existing contact
    if (editingContactIndex !== null) {
        const oldContact = list[editingContactIndex];

        // RENEWAL LOGIC: Check if plan dates are being changed (for renewal message)
        const settings = JSON.parse(localStorage.getItem('wa_notification_settings') || '{}');
        const hasRenewalMessage = settings.renewalMsg && settings.renewalMsg.trim() !== "";

        // Check if either start date or end date is being changed
        const startDateChanged = (oldContact.startDate !== contactData.startDate) && contactData.startDate;
        const endDateChanged = (oldContact.endDate !== contactData.endDate) && contactData.endDate;

        if ((startDateChanged || endDateChanged) && hasRenewalMessage) {
            console.log(`[Renewal Trigger] Plan dates updated for ${contactData.name}`);
            console.log(`  Old dates: Start=${oldContact.startDate}, End=${oldContact.endDate}`);
            console.log(`  New dates: Start=${contactData.startDate}, End=${contactData.endDate}`);

            // Send renewal notification
            setTimeout(async () => {
                try {
                    const success = await triggerAutomatedNotification('renewal', contactData);
                    if (success) {
                        // Mark renewal as sent in the contact data
                        contactData.renewalNotified = true;
                        contactData.renewalNotifiedAt = new Date().toISOString();

                        // Also reset expiry notification flag if end date changed
                        if (endDateChanged) {
                            contactData.notifiedEnd = false;
                            contactData.notifiedAt = null;
                        }

                        // Update the contact in the list
                        list[editingContactIndex] = contactData;
                        localStorage.setItem('wa_contacts', JSON.stringify(list));

                        console.log(`[Renewal Trigger] ✅ Renewal sent and contact updated`);

                        // Reload contacts to show updated status
                        loadContacts();

                        showToast(`Renewal message sent to ${contactData.name}`, 'success');
                    }
                } catch (error) {
                    console.error("Error sending renewal:", error);
                }
            }, 1000);
        }

        // Preserve original start date if not changed
        if (!start && oldContact.startDate) {
            contactData.startDate = oldContact.startDate;
        }

        // Preserve notification statuses
        contactData.notifiedEnd = oldContact.notifiedEnd || false;
        contactData.notifiedAt = oldContact.notifiedAt || null;
        contactData.startNotified = oldContact.startNotified || false;
        contactData.startNotifiedAt = oldContact.startNotifiedAt || null;
        contactData.renewalNotified = oldContact.renewalNotified || false;
        contactData.renewalNotifiedAt = oldContact.renewalNotifiedAt || null;

        list[editingContactIndex] = contactData;
        showToast('Contact Updated', 'success');

        // Reset UI
        editingContactIndex = null;
        const addBtn = document.getElementById('addContactBtn');
        addBtn.innerHTML = '<i class="bi bi-person-plus-fill"></i> Add Contact';
        addBtn.classList.replace('btn-warning', 'btn-primary');
    }
    // Add new contact
    else {
        if (list.some(c => c.phone === cleanPhone)) {
            showToast('Number already saved.', 'warning');
            return;
        }

        list.push(contactData);
        showToast('Contact Added', 'success');

        // Send welcome message if start date is set and is today
        if (start) {
            const startDate = new Date(start);
            startDate.setHours(0, 0, 0, 0);
            const today = new Date();
            today.setHours(0, 0, 0, 0);

            if (startDate.getTime() === today.getTime()) {
                setTimeout(async () => {
                    try {
                        await triggerAutomatedNotification('start', contactData);
                    } catch (error) {
                        console.error("Error sending welcome:", error);
                    }
                }, 1000);
            }
        }
    }

    localStorage.setItem('wa_contacts', JSON.stringify(list));

    // Clear inputs
    document.getElementById('contactName').value = '';
    document.getElementById('contactPhone').value = '';
    document.getElementById('contactStart').value = '';
    document.getElementById('contactEnd').value = '';

    loadContacts();

    // Log activity
    logActivity({
        type: 'contact',
        message: editingContactIndex !== null ? `Updated contact: ${name || cleanPhone}` : `Added contact: ${name || cleanPhone}`,
        success: true
    });
}

function deleteContact(idx) {
    if (!confirm('Are you sure you want to delete this contact?')) return;

    const list = JSON.parse(localStorage.getItem('wa_contacts') || '[]');
    const contact = list[idx];
    list.splice(idx, 1);
    localStorage.setItem('wa_contacts', JSON.stringify(list));

    // FIX: Add this line to refresh the contact list
    loadContacts();

    showToast('Contact deleted.', 'info');

    // Log activity
    logActivity({
        type: 'contact',
        message: `Deleted contact: ${contact?.name || contact?.phone}`,
        success: true
    });
}

function saveSingleContact() {
    const phone = document.getElementById('singleNumber').value.trim();
    if (!phone) {
        showToast('Enter a recipient number first.', 'warning');
        return;
    }

    const list = JSON.parse(localStorage.getItem('wa_contacts') || '[]');
    const cleanPhone = phone.replace(/[^0-9+]/g, '');

    if (list.some(c => c.phone === cleanPhone)) {
        showToast('This number is already in your contacts.', 'info');
        return;
    }

    const name = prompt("Enter a name for this contact:", cleanPhone) || cleanPhone;
    list.push({
        name: name,
        phone: cleanPhone,
        createdAt: new Date().toISOString()
    });

    localStorage.setItem('wa_contacts', JSON.stringify(list));
    loadContacts();
    showToast(`Saved contact: ${name}`, 'success');
}

function fillNumber(phone) {
    document.getElementById('singleNumber').value = phone;
    showView('send');
}

/* ========================================================================== */
/* 7. BULK SENDING SYSTEM - FIXED DUPLICATE ISSUE                           */
/* ========================================================================== */

function toggleBulkControls(state) {
    const pauseBtn = document.getElementById('pauseBulkBtn');
    const resumeBtn = document.getElementById('resumeBulkBtn');
    const stopBtn = document.getElementById('stopBulkBtn');
    const sendBtn = document.getElementById('sendBulkBtn');

    if (!pauseBtn) return;

    if (state === 'running') {
        pauseBtn.disabled = false;
        resumeBtn.disabled = true;
        stopBtn.disabled = false;
        sendBtn.disabled = true;

        pauseBtn.classList.remove('btn-secondary');
        pauseBtn.classList.add('btn-warning');
        resumeBtn.classList.remove('btn-success');
        resumeBtn.classList.add('btn-secondary');

    } else if (state === 'paused') {
        pauseBtn.disabled = true;
        resumeBtn.disabled = false;
        stopBtn.disabled = false;
        sendBtn.disabled = true;

        pauseBtn.classList.remove('btn-warning');
        pauseBtn.classList.add('btn-secondary');
        resumeBtn.classList.remove('btn-secondary');
        resumeBtn.classList.add('btn-success');

    } else {
        pauseBtn.disabled = true;
        resumeBtn.disabled = true;
        stopBtn.disabled = true;
        sendBtn.disabled = false;

        pauseBtn.classList.add('btn-secondary');
        resumeBtn.classList.add('btn-secondary');
    }
}

async function sendBulkList() {
    // Clear processed contacts set to prevent duplicates
    processedContacts.clear();

    // Get selected contacts
    const selectedSaved = [...document.querySelectorAll('#bulkContactsList input.bulk-contact:checked')].map(ch => ({
        phone: ch.dataset.phone,
        name: ch.dataset.name
    }));

    // Get manual input
    const manualInput = document.getElementById('bulkList')?.value.trim() || '';
    const manualList = manualInput
        ? manualInput.split(/\r?\n/).map(s => ({ phone: s.trim().replace(/[^0-9+]/g, ''), name: '' })).filter(x => x.phone)
        : [];

    // Get CSV uploaded contacts
    let csvList = (typeof parsedBulk !== 'undefined')
        ? parsedBulk.map(n => ({ phone: n.replace(/[^0-9+]/g, ''), name: '' })).filter(x => x.phone)
        : [];

    // Combine all sources and remove duplicates
    const allContacts = [...selectedSaved, ...manualList, ...csvList];

    // Remove duplicate phone numbers
    const phoneSet = new Set();
    const finalList = [];

    for (const contact of allContacts) {
        if (!phoneSet.has(contact.phone)) {
            phoneSet.add(contact.phone);
            finalList.push(contact);
        }
    }

    if (!finalList.length) {
        showToast('No recipients selected or entered.', 'error');
        return;
    }

    // Validate content
    const fileEl = document.getElementById('bulkFile');
    const messageRaw = document.getElementById('bulkMessage').value.trim() || ' ';
    const hasFile = fileEl.files.length > 0;

    if (!hasFile && messageRaw.trim() === '') {
        showToast('Please provide a message or select a file.', 'warning');
        return;
    }

    if (!confirm(`Ready to send to ${finalList.length} unique recipients?\nClick OK to start.`)) {
        return;
    }

    // Check if enterprise settings should be used
    const useEnterprise = finalList.length > 100;
    if (useEnterprise) {
        // Show enterprise settings panel
        const enterprisePanel = document.getElementById('enterpriseBulkSettings');
        if (enterprisePanel) {
            enterprisePanel.classList.add('show');
        }

        // Use enterprise bulk sending
        await sendBulkEnterprise(finalList, messageRaw, hasFile, fileEl);
        return;
    }

    // Regular bulk sending for smaller batches
    isBulkPaused = false;
    isBulkStopped = false;
    toggleBulkControls('running');

    // Prepare file
    let originalBase64 = '', filename = '', fileType = '';
    if (hasFile) {
        const f = fileEl.files[0];
        if (f.size > appConfig.maxFileSizeBytes) {
            toggleBulkControls('idle');
            showToast(`File exceeds ${appConfig.maxFileSizeMB}MB limit.`, 'error');
            return;
        }
        filename = f.name;
        fileType = f.type;
        originalBase64 = await fileToBase64(f);
    }

    // Status UI
    const bulkStatusDiv = document.getElementById('bulkPreview');
    let successfulSends = 0;
    let failedSends = 0;

    function updateBulkStatus(statusText, currentIndex, totalCount) {
        if (bulkStatusDiv) {
            bulkStatusDiv.innerHTML = `
                <div class="alert alert-warning">
                    <h5><i class="bi bi-gear-wide-connected fa-spin"></i> Processing...</h5>
                    <div><strong>Status:</strong> ${statusText}</div>
                    <div><strong>Progress:</strong> ${currentIndex} / ${totalCount}</div>
                    <div class="mt-2">
                        <span class="badge bg-success">Success: ${successfulSends}</span>
                        <span class="badge bg-danger">Failed: ${failedSends}</span>
                    </div>
                </div>`;
        }
    }

    updateBulkStatus('Initializing...', 0, finalList.length);

    // Main loop
    for (let i = 0; i < finalList.length; i++) {
        if (isBulkStopped) {
            updateBulkStatus('Stopped by User', i, finalList.length);
            showToast('Bulk sending stopped.', 'error');
            break;
        }

        while (isBulkPaused && !isBulkStopped) {
            updateBulkStatus('PAUSED', i, finalList.length);
            await sleep(1000);
        }
        if (isBulkStopped) break;

        // ... existing loop code ...
const item = finalList[i];
const to = item.phone;
const name = item.name || to;

// 1. Check if the message contains the {name} tag
const containsNameTag = messageRaw.includes('{name}');

// FIX: Use the Enterprise Parser to handle {name}, {date}, and {filename}
let personalizedMsg = parseMessageVariables(messageRaw, name, filename);
if (!personalizedMsg.trim()) personalizedMsg = ' ';

updateBulkStatus(`Sending to ${name}`, i + 1, finalList.length);

let base64ToSend = originalBase64;
let filenameToSend = filename;

// 2. MODIFIED WATERMARK LOGIC: Only apply if {name} is in the message
const isWatermarking = hasFile && appConfig.enableWatermarking && containsNameTag;

if (isWatermarking) {
    try {
        const watermarkText = generateWatermarkText(name, to);
        // This only runs now if {name} was typed in the message box
        base64ToSend = await getWatermarkedBase64(originalBase64, fileType, watermarkText, 'diagonal');
        console.log(`[Watermark] Tag {name} detected. Applied for ${name}`);
    } catch (e) {
        console.error(`Watermark failed for ${name}`, e);
    }
} else if (hasFile && appConfig.enableWatermarking && !containsNameTag) {
    console.log(`[System] Watermark skipped: No {name} tag found in message.`);
}


        const payload = buildPayload(to, personalizedMsg, base64ToSend, filenameToSend);
        const dummyResultDiv = { innerHTML: '' };
        const result = await postSendAndHandleResponse(payload, filenameToSend, personalizedMsg, to, dummyResultDiv);

        if (result) {
            successfulSends++;
            processedContacts.add(to); // Mark as processed
        } else {
            failedSends++;
        }

        // Smart delay (don't delay after last message)
        if (i < finalList.length - 1) {
            const delay = getSmartDelay(isWatermarking, i, finalList.length);
            if (bulkStatusDiv) {
                bulkStatusDiv.insertAdjacentHTML('beforeend',
                    `<div class="small text-muted mt-1"><i class="bi bi-hourglass"></i> Waiting ${delay}ms...</div>`);
            }
            await sleep(delay);
        }
    }

    // Finalize
    toggleBulkControls('idle');

    if (isBulkStopped) {
        // NEW: Update UI to show the stopped state
        if (bulkStatusDiv) {
            bulkStatusDiv.innerHTML = `
                <div class="alert alert-danger">
                    <h4><i class="bi bi-stop-circle-fill"></i> Batch Stopped by User</h4>
                    <p class="mb-0">Processed ${successfulSends + failedSends} out of ${finalList.length || recipients.length} contacts before stopping.</p>
                </div>`;
        }
        // Log the stopped event
        logActivity({
            type: 'bulk',
            message: `Bulk send stopped manually. Sent: ${successfulSends}`,
            success: successfulSends,
            failed: failedSends
        });
    } else {
        // Your existing success UI block
        if (bulkStatusDiv) {
            bulkStatusDiv.innerHTML = `
                <div class="alert alert-success">
                    <h4><i class="bi bi-check-circle-fill"></i> Batch Completed</h4>
                    <p>Total Processed: ${finalList ? finalList.length : recipients.length}</p>
                    <hr>
                    <p class="mb-0">
                        <strong>Successful:</strong> ${successfulSends} | 
                        <strong>Failed:</strong> ${failedSends}
                    </p>
                </div>`;
        }

        logActivity({
            type: 'bulk',
            message: `Bulk send completed`,
            success: successfulSends,
            failed: failedSends
        });

        showToast('Bulk Batch Completed!', 'success');
        updateMessageCount();
    }
}

async function sendBulkEnterprise(recipients, message, hasFile, fileEl) {
    if (!confirm(`Send to ${recipients.length} unique contacts in batches of ${appConfig.batchSize}?`)) {
        return;
    }

    isBulkPaused = false;
    isBulkStopped = false;
    toggleBulkControls('running');

    // Prepare file
    let originalBase64 = '', filename = '', fileType = '';
    if (hasFile && fileEl.files.length > 0) {
        const f = fileEl.files[0];
        if (f.size > appConfig.maxFileSizeBytes) {
            toggleBulkControls('idle');
            showToast(`File exceeds ${appConfig.maxFileSizeMB}MB limit.`, 'error');
            return;
        }
        filename = f.name;
        fileType = f.type;
        originalBase64 = await fileToBase64(f);
    }

    const bulkStatusDiv = document.getElementById('bulkPreview');
    let successfulSends = 0;
    let failedSends = 0;
    let batchNumber = 1;

    // Split into batches
    const batches = [];
    for (let i = 0; i < recipients.length; i += appConfig.batchSize) {
        batches.push(recipients.slice(i, i + appConfig.batchSize));
    }

    showToast(`Processing ${batches.length} batches`, 'info');

    for (const batch of batches) {
        if (isBulkStopped) break;

        // Update UI
        if (bulkStatusDiv) {
            bulkStatusDiv.innerHTML = `
                <div class="alert alert-warning">
                    <h5><i class="bi bi-gear-wide-connected fa-spin"></i> Processing Batch ${batchNumber}/${batches.length}</h5>
                    <div><strong>Progress:</strong> ${successfulSends + failedSends} / ${recipients.length}</div>
                    <div class="mt-2">
                        <span class="badge bg-success">Success: ${successfulSends}</span>
                        <span class="badge bg-danger">Failed: ${failedSends}</span>
                    </div>
                </div>`;
        }

        // Process batch
        for (let i = 0; i < batch.length; i++) {
            if (isBulkStopped) break;

            // Check pause state & Update UI
            let wasPaused = false;
            while (isBulkPaused && !isBulkStopped) {
                wasPaused = true;
                if (bulkStatusDiv) {
                    const h5 = bulkStatusDiv.querySelector('h5');
                    if (h5 && !h5.innerHTML.includes('Paused')) {
                        h5.innerHTML = '<i class="bi bi-pause-circle-fill text-danger"></i> Paused by User...';
                    }
                }
                await sleep(1000);
            }
            if (isBulkStopped) break;

            // Restore "Processing" UI if it just resumed
            if (wasPaused && !isBulkStopped) {
                if (bulkStatusDiv) {
                    const h5 = bulkStatusDiv.querySelector('h5');
                    if (h5) {
                        h5.innerHTML = `<i class="bi bi-gear-wide-connected fa-spin text-primary"></i> Processing Batch ${batchNumber}/${batches.length}`;
                    }
                }
            }
            const item = batch[i];
            const to = item.phone;
            const name = item.name || to;

            // FIX: Use the parseMessageVariables function here!
            // This ensures {name}, {date}, and {filename} are replaced for EVERY contact.
            let personalizedMsg = parseMessageVariables(message, name, filename);

            let base64ToSend = originalBase64;
            let filenameToSend = filename;

            // Check if watermarking is needed (Still using {name} tag detection for speed)
            const containsNameTag = message.includes('{name}');
            const isWatermarking = hasFile && appConfig.enableWatermarking && containsNameTag;

            if (isWatermarking) {
                try {
                    const watermarkText = generateWatermarkText(name, to);
                    base64ToSend = await getWatermarkedBase64(originalBase64, fileType, watermarkText, 'diagonal');
                } catch (e) {
                    console.error(`Watermark failed for ${name}`, e);
                }
            }

            // ACCOUNT POOLING / ROUTING LOGIC
            const overallIndex = ((batchNumber - 1) * appConfig.batchSize) + i;
            const currentInstance = getRoutedInstance(overallIndex, recipients.length);

            // ANTI-BAN: Pause if switching instances to look like a human swapping phones
            if (overallIndex > 0) {
                const prevInstance = getRoutedInstance(overallIndex - 1, recipients.length);
                if (prevInstance.id !== currentInstance.id && appConfig.pauseOnInstanceSwitch > 0) {
                    if (bulkStatusDiv) {
                        bulkStatusDiv.insertAdjacentHTML('beforeend', 
                            `<div class="small text-primary mt-2"><i class="bi bi-shuffle"></i> Swapping to Instance: ${currentInstance.name} (Waiting ${appConfig.pauseOnInstanceSwitch/1000}s)</div>`
                        );
                    }
                    await sleep(appConfig.pauseOnInstanceSwitch);
                }
            }

            // BUILD PAYLOAD FOR THIS SPECIFIC NUMBER
            const payload = buildPayload(to, personalizedMsg, base64ToSend, filenameToSend, currentInstance);
            const dummyResultDiv = { innerHTML: '' };
            
            // SEND USING THE ROUTED INSTANCE
            const result = await postSendAndHandleResponse(payload, filenameToSend, personalizedMsg, to, dummyResultDiv, currentInstance);

            // ==========================================

            if (result) {
                successfulSends++;
                processedContacts.add(to);
            } else {
                failedSends++;
            }

            // Smart delay between sends in batch (optimized for watermarking)
            const delay = getSmartDelay(isWatermarking, successfulSends + failedSends, recipients.length);
            if (i < batch.length - 1) {
                await sleep(delay);
            }
        } // <--- END OF INNER LOOP

        batchNumber++;

        // Delay between batches (except last batch)
        if (batchNumber <= batches.length && !isBulkStopped) {
            await sleep(appConfig.batchDelay);
        }
    } // <--- END OF OUTER LOOP

    // Finalize
    toggleBulkControls('idle');

    if (isBulkStopped) {
        // Update UI to show the stopped state
        if (bulkStatusDiv) {
            bulkStatusDiv.innerHTML = `
                <div class="alert alert-danger">
                    <h4><i class="bi bi-stop-circle-fill"></i> Batch Stopped by User</h4>
                    <p class="mb-0">Processed ${successfulSends + failedSends} out of ${recipients.length} contacts before stopping.</p>
                </div>`;
        }
        // Log the stopped event
        logActivity({
            type: 'bulk',
            message: `Bulk send stopped manually. Sent: ${successfulSends}`,
            success: successfulSends,
            failed: failedSends
        });
    } else {
        // Success UI block
        if (bulkStatusDiv) {
            bulkStatusDiv.innerHTML = `
                <div class="alert alert-success">
                    <h4><i class="bi bi-check-circle-fill"></i> Batch Completed</h4>
                    <p>Total Processed: ${recipients.length}</p>
                    <hr>
                    <p class="mb-0">
                        <strong>Successful:</strong> ${successfulSends} | 
                        <strong>Failed:</strong> ${failedSends}
                    </p>
                </div>`;
        }

        logActivity({
            type: 'bulk',
            message: `Bulk send completed`,
            success: successfulSends,
            failed: failedSends
        });

        showToast('Bulk Batch Completed!', 'success');
        updateMessageCount();
    }
}


function handleBulkCsv(e) {
    const f = e.target.files[0];
    if (!f) return;

    const reader = new FileReader();
    reader.onload = () => {
        parsedBulk = reader.result.split(/\r?\n/)
            .map(s => s.trim())
            .filter(Boolean)
            .map(n => n.replace(/[^0-9+]/g, ''));
        renderBulkPreview();
    };
    reader.readAsText(f);
}

function previewBulkList() {
    const pasted = document.getElementById('bulkList').value.trim();
    parsedBulk = [];
    if (pasted) {
        parsedBulk = pasted.split(/\r?\n/)
            .map(s => s.trim())
            .filter(Boolean)
            .map(n => n.replace(/[^0-9+]/g, ''));
    }
    renderBulkPreview();
}

function renderBulkPreview() {
    const el = document.getElementById('bulkPreview');
    if (!el) return;

    if (!parsedBulk.length) {
        el.innerHTML = '<div class="text-muted text-center p-3 border rounded">No recipients parsed yet.</div>';
        return;
    }

    el.innerHTML = `
        <div class="alert alert-info">
            <strong>${parsedBulk.length}</strong> recipients ready from CSV/Manual input. 
            <div class="small text-muted mt-1 text-truncate">
                ${parsedBulk.slice(0, 10).join(', ')}${parsedBulk.length > 10 ? '...' : ''}
            </div>
        </div>`;
}

/* ========================================================================== */
/* 8. SINGLE SEND FUNCTION - FIXED "BOTH" OPTION                             */
/* ========================================================================== */

function updateSendModeUI(mode) {
    const fileSection = document.getElementById('singleFileSection');
    const messageSection = document.getElementById('singleMessageSection');

    switch (mode) {
        case 'file':
            if (fileSection) fileSection.style.display = 'block';
            if (messageSection) messageSection.style.display = 'none';
            break;
        case 'message':
            if (fileSection) fileSection.style.display = 'none';
            if (messageSection) messageSection.style.display = 'block';
            break;
        case 'both':
            if (fileSection) fileSection.style.display = 'block';
            if (messageSection) messageSection.style.display = 'block';
            break;
    }
}

async function sendSingle() {
    const toInput = document.getElementById('singleNumber');
    const fileInput = document.getElementById('singleFile');
    const messageInput = document.getElementById('singleMessage');
    const resultDiv = document.getElementById('singleResult');

    resultDiv.innerHTML = '';

    const to = toInput.value.trim().replace(/[^0-9+]/g, '');
    if (!to) {
        showToast('Please enter a recipient number.', 'error');
        return;
    }

    // Get selected mode
    const sendMode = document.querySelector('input[name="sendMode"]:checked')?.value || 'both';

    const messageRaw = messageInput.value.trim();
    const hasFile = fileInput.files.length > 0;

    let base64ToSend = '';
    let filenameToSend = '';
    let messageToSend = '';
    let fileToProcess = null;

    // Validation based on mode
    if (sendMode === 'file' && !hasFile) {
        showToast('File mode selected but no file chosen.', 'warning');
        return;
    }

    if (sendMode === 'message' && !messageRaw) {
        showToast('Message mode selected but message is empty.', 'warning');
        return;
    }

    if (sendMode === 'both' && !hasFile && !messageRaw) {
        showToast('Both mode requires either a file or message.', 'warning');
        return;
    }

    // File processing
    if (hasFile && (sendMode === 'both' || sendMode === 'file')) {
        fileToProcess = fileInput.files[0];

        if (fileToProcess.size > appConfig.maxFileSizeBytes) {
            showToast(`File exceeds ${appConfig.maxFileSizeMB}MB limit.`, 'error');
            return;
        }

        filenameToSend = fileToProcess.name;
        resultDiv.innerHTML = '<div class="alert alert-info" id="singleProgress"><span class="spinner-border spinner-border-sm"></span> Encoding file...</div>';

        try {
            base64ToSend = await fileToBase64(fileToProcess);
        } catch (e) {
            showToast('Failed to encode file.', 'error');
            return;
        }
    }

    // Message processing (FIX)
    if (sendMode === 'both' || sendMode === 'message') {
        messageToSend = messageRaw || ' ';
    }

    if (sendMode === 'file' && !messageToSend) {
        messageToSend = ' '; // REQUIRED for API
    }


    // Final validation
    if (!messageToSend && !base64ToSend) {
        showToast('Nothing to send.', 'error');
        return;
    }

    // Build payload with Variable Parsing
    // Parse variables for single send
    const parsedMsg = parseMessageVariables(messageToSend, "வாடிக்கையாளர்", filenameToSend);
    const payload = buildPayload(to, parsedMsg, base64ToSend, filenameToSend);
    
    const success = await postSendAndHandleResponse(payload, filenameToSend, parsedMsg, to, resultDiv);
    if (success) {
        // Clear form on success
        if (sendMode !== 'message') {
            fileInput.value = '';
        }
        if (sendMode !== 'file') {
            messageInput.value = '';
        }
        updateMessageCount();
    }
}

/* ========================================================================== */
/* 9. SCHEDULER SYSTEM - FIXED (Uses IndexedDB for Large Files & Stability)   */
/* ========================================================================== */

/**
 * Initialize scheduler loop
 */
function initializeScheduler() {
    if (window.schedulerInterval) clearInterval(window.schedulerInterval);

    // Check every 10 seconds
    window.schedulerInterval = setInterval(async () => {
        if (isSchedulerRunning || isSchedulerPaused || isSchedulerStopped) return;
        isSchedulerRunning = true;
        try {
            await processScheduledJobs();
        } catch (error) {
            console.error("Scheduler error:", error);
        } finally {
            isSchedulerRunning = false;
        }
    }, 10000);

    console.log("Scheduler initialized (Database Mode)");
}

/**
 * Main Scheduler Logic
 */
/**
 * Main Scheduler Logic (Lazy Loading Architecture)
 */
async function processScheduledJobs() {
  let schedules = [];
    try { schedules = await getAllSchedulesMeta(); } catch (e) { return; }
    if (!schedules.length) return;

    const now = new Date();
    const todayStr = getLocalDateString(); // Get current YYYY-MM-DD
    const currentHour = now.getHours();
    const currentMinute = now.getMinutes();

    // Find jobs due specifically TODAY and at this TIME
    const dueJobs = schedules.filter(job => {
        if (job.sent) return false;
        
        // Match Date
        if (job.date !== todayStr) return false;

        // Match Time
        const [jobH, jobM] = job.time.split(':').map(Number);
        const diff = (currentHour * 60 + currentMinute) - (jobH * 60 + jobM);
        return diff >= 0 && diff <= 1; 
    });

    if (!dueJobs.length) return;

    let activeId = document.getElementById('instance_id')?.value;
    let activeToken = document.getElementById('token')?.value;

    if (!activeId) {
        const saved = JSON.parse(localStorage.getItem('wa_app_config') || '{}');
        activeId = saved.currentInstanceId;
        activeToken = saved.currentToken;
    }

    if (!activeId || !activeToken) return;

    // 3. Execute Jobs
    for (const meta of dueJobs) {
        if (meta.status === 'processing' || meta.sent) continue;

        meta.status = 'processing';
        await updateScheduleMeta(meta); // Mark UI as processing
        renderSchedules();
        try {
            // JUST-IN-TIME FETCH: Now we pull the 5000 contacts and 30MB file!
            const heavyData = await getScheduleData(meta.id);

            if (!heavyData) throw new Error("Schedule data missing from database");

            // Reconstruct the full job for the executor function
            const fullJob = {
                ...meta,
                recipients: heavyData.recipients,
                fileMeta: meta.hasFile ? {
                    filename: meta.filename,
                    type: heavyData.fileType,
                    base64: heavyData.base64
                } : null
            };

            await executeScheduledJob(fullJob, activeId, activeToken);

            // Mark as Sent
            meta.sent = true;
            meta.sentAt = new Date().toISOString();
            meta.status = 'sent';
            await updateScheduleMeta(meta);

            // ENTERPRISE CLEANUP: Delete the 30MB file from DB to save hard drive space!
            await clearHeavyDataAfterSend(meta.id);
            console.log(`Job ${meta.id} Completed & Heavy Data Cleared`);

        } catch (error) {
            console.error(`Job ${meta.id} Failed`, error);
            meta.status = 'failed';
            await updateScheduleMeta(meta);
            
            // MOVED INSIDE THE CATCH BLOCK: Now it only logs if a real failure happens
            logActivity({
                type: 'system',
                message: `Scheduled Batch Failed: ${error.message}`,
                success: false,
                jobId: meta.id
            });
        }

        await new Promise(r => setTimeout(r, 2000));
    }

    renderSchedules();
}
/**
 * Execute Single Job (With Visual Progress UI)
 */
/**
 * Execute Single Job (Visuals + Logging Fix)
 */
/**
 * Execute Single Job (Upgraded with Account Pooling & Anti-Ban Smart Delays)
 */
async function executeScheduledJob(job, instanceId, token) {
    console.log(`[Scheduler] Starting Job ${job.id}`);

    // 1. SETUP UI: Create the "Processing" Box
    const resultDiv = document.getElementById('scheduleList');
    let statusDiv = null;

    if (resultDiv) {
        statusDiv = document.createElement('div');
        statusDiv.id = `job-status-${job.id}`;
        statusDiv.className = 'alert alert-info shadow-sm mb-3 border-info';
        statusDiv.innerHTML = `
            <div class="d-flex align-items-center">
                <div class="spinner-border spinner-border-sm text-primary me-3" role="status"></div>
                <div class="flex-grow-1">
                    <h6 class="mb-0 fw-bold text-primary">
                        <i class="bi bi-send-fill"></i> Starting Scheduled Batch...
                    </h6>
                    <small class="text-muted">Time: ${job.time}</small>
                </div>
            </div>`;
        resultDiv.prepend(statusDiv);
    }

    let successCount = 0;
    let failCount = 0;
    const totalRecipients = job.recipients.length;

    // 2. Loop Through Recipients
    for (let i = 0; i < totalRecipients; i++) {

        // Handle Pause Loop BEFORE Stop check
        while (isSchedulerPaused && !isSchedulerStopped) {
            if (statusDiv) {
                const h6 = statusDiv.querySelector('h6');
                if (h6 && !h6.innerHTML.includes('Paused')) {
                    h6.innerHTML = '<i class="bi bi-pause-circle-fill text-warning"></i> Paused...';
                }
            }
            await new Promise(r => setTimeout(r, 1000)); // Wait 1 second and check again
        }

        // Handle Stop
        if (isSchedulerStopped) {
            if (statusDiv) {
                statusDiv.className = 'alert alert-danger shadow-sm mb-3 border-danger';
                statusDiv.innerHTML = `<div class="fw-bold text-danger"><i class="bi bi-stop-circle"></i> Stopped by user at ${i}/${totalRecipients}.</div>`;
            }
            break; // Immediately exit the loop
        }

        const recipient = job.recipients[i];
        const to = typeof recipient === 'string' ? recipient : recipient.phone;
        const name = recipient.name || to;

        // Update UI
        if (statusDiv) {
            const percent = Math.round(((i) / totalRecipients) * 100);
            statusDiv.innerHTML = `
                <div class="d-flex justify-content-between align-items-center mb-2">
                    <div>
                        <strong class="text-primary"><i class="bi bi-whatsapp"></i> Sending ${i + 1}/${totalRecipients}</strong>
                        <div class="small text-dark">To: <b>${escapeHtml(name)}</b></div>
                        ${job.fileMeta ? `<div class="small text-muted"><i class="bi bi-paperclip"></i> ${job.fileMeta.filename}</div>` : ''}
                    </div>
                    <div class="text-end">
                        <span class="badge bg-success me-1">${successCount} <i class="bi bi-check"></i></span>
                        <span class="badge bg-danger">${failCount} <i class="bi bi-x"></i></span>
                    </div>
                </div>
                <div class="progress" style="height: 6px;">
                    <div class="progress-bar progress-bar-striped progress-bar-animated bg-primary" 
                         role="progressbar" style="width: ${percent}%"></div>
                </div>`;
        }

        let isWatermarking = false;

        try {
            // 1. Get the Tamil Date from the specific date set in the schedule (e.g., 08-மார்ச்-2026)
            const scheduledTamilDate = formatTamilDateFromStr(job.date);
            const scheduleFilename = job.fileMeta ? job.fileMeta.filename : "";

            // 2. Advanced Parser: Handles {name}, {date}, and {filename}
            let body = (job.message || ' ')
                .replace(/{name}/g, name || "வாடிக்கையாளர்")
                .replace(/{date}/g, scheduledTamilDate)
                .replace(/{filename}/g, scheduleFilename.replace(/\.[^/.]+$/, "") || "கோப்பு");

            const containsNameTag = job.message && job.message.includes('{name}');
            let base64 = '';
            let filename = '';

            if (job.fileMeta) {
                base64 = job.fileMeta.base64;
                filename = job.fileMeta.filename;
                isWatermarking = appConfig.enableWatermarking && containsNameTag;

                if (isWatermarking && typeof getWatermarkedBase64 === 'function') {
                    const wmText = generateWatermarkText(name, to);
                    base64 = await getWatermarkedBase64(base64, job.fileMeta.type, wmText);
                    console.log(`[Scheduler] Watermark applied for ${name} (Tag detected)`);
                } else if (appConfig.enableWatermarking && !containsNameTag) {
                    console.log(`[Scheduler] Watermark skipped for ${name} (No {name} tag)`);
                }
            }

            // ==========================================
            // ACCOUNT POOLING / ROUTING LOGIC (SCHEDULER)
            // ==========================================
            
            // 1. GET ROUTED INSTANCE FOR SCHEDULER
            const currentInstance = getRoutedInstance(i, totalRecipients);

            // 2. ANTI-BAN SWITCHING PAUSE
            if (i > 0) {
                const prevInstance = getRoutedInstance(i - 1, totalRecipients);
                if (prevInstance.id !== currentInstance.id && appConfig.pauseOnInstanceSwitch > 0) {
                    if (statusDiv) statusDiv.querySelector('.text-dark').innerHTML += `<br><span class="text-primary small"><i class="bi bi-shuffle"></i> Swapped to: ${currentInstance.name} (Waiting...)</span>`;
                    await sleep(appConfig.pauseOnInstanceSwitch);
                }
            }

            // 3. Build Payload specifically for the routed instance
            const payload = buildPayload(to, body, base64, filename, currentInstance);

            const dummyDiv = document.createElement('div');
            
            // 4. Send & Capture Result using the specific instance
            const result = await postSendAndHandleResponse(payload, filename, body, to, dummyDiv, currentInstance);

            if (result) successCount++;
            else failCount++;

        } catch (e) {
            console.error(`Failed to send to ${to}`, e);
            failCount++;
        }

        // ==========================================
        // SMART DELAY UPGRADE
        // ==========================================
        // Delay logic now respects your Admin settings (Jitter, Progressive Delay, Watermark optimizations)
        if (i < totalRecipients - 1) {
            const delay = getSmartDelay(isWatermarking, i, totalRecipients);
            await sleep(delay);
        }
    }

    // 3. LOGGING FIX: Save to Dashboard & History
    logActivity({
        type: 'scheduled',
        message: `Scheduled Batch Finished: ${job.time}`,
        recipients: totalRecipients,
        success: successCount,
        failed: failCount,
        jobId: job.id,
        time: new Date().toLocaleString()
    });

    // Update Dashboard Counters Immediately
    if (typeof updateMessageCount === 'function') updateMessageCount();
    const dashView = document.getElementById('view-dashboard');
    if (dashView && dashView.classList.contains('active')) {
        renderDashboard();
    }

    // 4. UI Cleanup
    if (statusDiv) {
        statusDiv.className = `alert ${failCount === 0 ? 'alert-success' : 'alert-warning'} mb-3 shadow-sm`;
        statusDiv.innerHTML = `
            <div class="d-flex align-items-center">
                <i class="bi ${failCount === 0 ? 'bi-check-circle-fill' : 'bi-exclamation-triangle-fill'} fs-4 me-3"></i>
                <div>
                    <h6 class="mb-0 fw-bold">Batch Finished</h6>
                    <div class="small">
                        Sent: <b>${successCount}</b> | Failed: <b>${failCount}</b>
                    </div>
                </div>
                <button type="button" class="btn-close ms-auto" onclick="this.parentElement.parentElement.remove()"></button>
            </div>`;

        setTimeout(() => {
            if (statusDiv && statusDiv.parentNode) statusDiv.remove();
        }, 8000);
    }
}
// Scheduler Controls
function pauseScheduler() {
    isSchedulerPaused = true;
    document.getElementById('pauseSchedulerBtn').disabled = true;
    document.getElementById('resumeSchedulerBtn').disabled = false;
    showToast('Scheduler paused', 'warning');
}

function resumeScheduler() {
    isSchedulerPaused = false;
    document.getElementById('pauseSchedulerBtn').disabled = false;
    document.getElementById('resumeSchedulerBtn').disabled = true;

    // UPGRADE: Restore UI text targeting the <strong> tag (since the progress bar overwrites the <h6> tag)
    const activeJobs = document.querySelectorAll('[id^="job-status-"] strong');
    activeJobs.forEach(strongTag => {
        if (strongTag.innerHTML.includes('Paused')) {
            strongTag.innerHTML = '<i class="bi bi-send-fill text-primary"></i> Resuming...';
            strongTag.className = 'text-primary'; // Revert back to the blue color
        }
    });

    showToast('Scheduler resumed', 'success');
}

function stopScheduler() {
    if (confirm('Stop all currently running and future scheduled jobs?')) {
        isSchedulerStopped = true;
        isSchedulerPaused = false; // Break out of any active pause loops

        // Disable both buttons
        document.getElementById('pauseSchedulerBtn').disabled = true;
        document.getElementById('resumeSchedulerBtn').disabled = true;

        showToast('Scheduler stopped', 'error');
    }
}
/**
 * Resets the scheduler after an emergency stop, allowing pending jobs to run again
 */
function resetScheduler() {
    if (!isSchedulerStopped && !isSchedulerPaused) {
        showToast('Scheduler is already running normally.', 'info');
        return;
    }

    if (confirm('Reset the scheduler? This will allow pending jobs to process on the next cycle.')) {
        // 1. Reset global state variables
        isSchedulerStopped = false;
        isSchedulerPaused = false;
        isSchedulerRunning = false; // Ensures the interval can pick up cleanly

        // 2. Reset the control buttons to their default states
        const pauseBtn = document.getElementById('pauseSchedulerBtn');
        const resumeBtn = document.getElementById('resumeSchedulerBtn');
        const stopBtn = document.getElementById('stopSchedulerBtn');

        if (pauseBtn) pauseBtn.disabled = false;
        if (resumeBtn) resumeBtn.disabled = true;
        if (stopBtn) stopBtn.disabled = false;

        // 3. Clean up the UI (remove any red "Stopped" status boxes)
        const statusDivs = document.querySelectorAll('[id^="job-status-"]');
        statusDivs.forEach(div => {
            if (div.innerHTML.includes('Stopped')) {
                div.remove();
            }
        });

        // 4. Update the Dashboard badge if it exists
        const badge = document.getElementById('schedulerStatusBadge');
        if (badge) {
            badge.className = 'badge bg-success';
            badge.textContent = 'Active';
        }

        showToast('Scheduler reset and ready for the next cycle.', 'success');
    }
}
/**
 * SAVE SCHEDULE (FIXED: Uses IndexedDB for Large Files)
 */
/**
 * SAVE SCHEDULE (Enterprise Split-Storage)
 */
async function saveLocalSchedule() {
    const time = document.getElementById('scheduleTime').value;
    const date = document.getElementById('scheduleDate')?.value; // Make sure you have an input with ID 'scheduleDate'
    
    if (!date || !time) return showToast('Please select both Date and Time.', 'error');

    // 1. Get Recipients
    const selectedSaved = [...document.querySelectorAll('#scheduleContactsList input.schedule-contact:checked')].map(ch => ({
        phone: ch.dataset.phone, name: ch.dataset.name
    }));
    const manualInput = document.getElementById('scheduleRecipients').value.trim();
    const manualList = manualInput ? manualInput.split(/\r?\n/).map(s => ({ phone: s.trim().replace(/[^0-9+]/g, ''), name: '' })).filter(x => x.phone) : [];

    const recipients = [...selectedSaved, ...manualList];
    if (!recipients.length) return showToast('Select at least one recipient.', 'error');

    // 2. Prepare Data
    const message = document.getElementById('scheduleMessage').value;
    const fileEl = document.getElementById('scheduleFile');
    const jobId = Date.now();
    const hasFile = fileEl.files.length > 0;

    // LIGHTWEIGHT UI DATA (Loads instantly)
    const scheduleMeta = {
        id: jobId,
        date: date, // Save the specific date (YYYY-MM-DD)
        time: time,
        recipientCount: recipients.length,
        message: message,
        hasFile: hasFile,
        filename: hasFile ? fileEl.files[0].name : '',
        created: new Date().toISOString(),
        sent: false,
        status: 'pending'
    };

    // HEAVYWEIGHT BACKGROUND DATA (Stays hidden until send time)
    const scheduleData = {
        id: jobId,
        recipients: recipients,
        fileType: '',
        base64: ''
    };

    const saveBtn = document.getElementById('saveScheduleBtn');

    // 3. Handle File & Save
    if (hasFile) {
        const f = fileEl.files[0];
        if (f.size > (100 * 1024 * 1024)) return showToast('File too large (Max 100MB)', 'error');

        saveBtn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> Processing File...';
        saveBtn.disabled = true;

        try {
            scheduleData.base64 = await fileToBase64(f);
            scheduleData.fileType = f.type;

            // SAVE TO DB (Split Architecture)
            await saveScheduleToDB(scheduleMeta, scheduleData);
            finishSave();
        } catch (e) {
            console.error(e);
            showToast('Failed to save file: ' + e.message, 'error');
            saveBtn.innerHTML = '<i class="bi bi-save"></i> Save Schedule';
            saveBtn.disabled = false;
        }
    } else {
        await saveScheduleToDB(scheduleMeta, scheduleData);
        finishSave();
    }

    function finishSave() {
        saveBtn.innerHTML = '<i class="bi bi-save"></i> Save Schedule';
        saveBtn.disabled = false;

        document.getElementById('scheduleMessage').value = '';
        document.getElementById('scheduleFile').value = '';
        document.querySelectorAll('#scheduleContactsList input:checked').forEach(cb => cb.checked = false);

        renderSchedules();
        logActivity({
            type: 'scheduled',
            message: `Created new schedule for ${time} (${recipients.length} recipients)`,
            success: true
        });

        showToast('Schedule Saved Successfully!', 'success');
    }
}

/**
 * UI RENDERER (Original Style with Pending/Completed Headers)
 */
async function renderSchedules() {
    const el = document.getElementById('scheduleList');
    if (!el) return;

    // FAST LOAD: Use Meta function
    let list = [];
    try { list = await getAllSchedulesMeta(); } catch (e) { }

    const sortedSchedules = list.sort((a, b) => {
        if (!a.sent && b.sent) return -1;
        if (a.sent && !b.sent) return 1;
        return a.time.localeCompare(b.time);
    });

    el.innerHTML = '';

    if (sortedSchedules.length === 0) {
        el.innerHTML = `
            <div class="text-center p-4">
                <i class="bi bi-calendar-x text-muted" style="font-size: 3rem;"></i>
                <h5 class="mt-3 text-muted">No schedules</h5>
                <p class="text-muted small">Create a schedule to send messages automatically</p>
            </div>`;
        return;
    }

    const pendingSchedules = sortedSchedules.filter(s => !s.sent);
    const completedSchedules = sortedSchedules.filter(s => s.sent);

    if (pendingSchedules.length > 0) {
        el.innerHTML += `<div class="mb-3"><h6 class="text-primary border-bottom pb-2"><i class="bi bi-clock-history"></i> Pending Schedules (${pendingSchedules.length})</h6></div>`;
        pendingSchedules.forEach(s => renderScheduleItem(s, el));
    }

    if (completedSchedules.length > 0) {
        el.innerHTML += `<div class="mb-3 mt-4"><h6 class="text-success border-bottom pb-2"><i class="bi bi-check-circle-fill"></i> Completed Schedules (${completedSchedules.length})</h6></div>`;
        completedSchedules.forEach(s => renderScheduleItem(s, el));
    }
}

function renderScheduleItem(schedule, container) {
    const fileIcon = schedule.hasFile ? '<i class="bi bi-paperclip text-primary ms-1" title="Attached"></i>' : '';
    // FIXED: Use recipientCount from metadata
    const recCount = schedule.recipientCount || 0;

    let badgeHtml = '';
    if (schedule.sent || schedule.status === 'sent') {
        badgeHtml = `<span class="badge bg-success ms-2"><i class="bi bi-check-lg"></i> Sent</span>`;
    } else if (schedule.status === 'failed') {
        badgeHtml = `<span class="badge bg-danger ms-2"><i class="bi bi-x-circle"></i> Failed (Check Logs)</span>`;
    } else if (schedule.status === 'processing') {
        badgeHtml = `<span class="badge bg-info ms-2"><span class="spinner-border spinner-border-sm"></span> Processing...</span>`;
    } else {
        badgeHtml = `<span class="badge bg-warning text-dark ms-2"><i class="bi bi-hourglass-split"></i> Pending</span>`;
    }
    const statusBadge = badgeHtml;

    const sentInfo = schedule.sent
        ? `<div class="small text-muted mt-1"><i class="bi bi-check-all"></i> Sent: ${new Date(schedule.sentAt).toLocaleString()}</div>`
        : '';

    const item = document.createElement('div');
    item.className = `card mb-3 shadow-sm ${schedule.sent ? 'bg-light border-success' : 'border-primary'}`;
    const fileNameDisplay = schedule.filename ? `<div class="small text-info mt-1"><i class="bi bi-file-earmark"></i> ${schedule.filename}</div>` : '';
    item.innerHTML = `
        <div class="card-body p-3">
            <div class="d-flex justify-content-between align-items-start">
                <div class="flex-grow-1">
                    <div class="d-flex align-items-center mb-2">
                        <h5 class="mb-0 me-2 text-dark"><i class="bi bi-watch"></i> ${schedule.time}</h5>
                        ${fileIcon}
                        ${statusBadge}
                    </div>
                    <div class="small text-muted mb-2">
                        <i class="bi bi-people"></i> <strong>${recCount}</strong> Recipients
                    </div>
                    ${sentInfo}
                    <div class="mt-2 p-2 bg-white border rounded text-secondary text-truncate" style="max-width: 80%;">
                        <i class="bi bi-chat-left-quote"></i> ${escapeHtml(schedule.message || 'No text')}
                    </div>
                    ${schedule.fileMeta ? `<div class="small text-info mt-1"><i class="bi bi-file-earmark"></i> ${schedule.fileMeta.filename}</div>` : ''}
                </div>
                <div class="d-flex flex-column gap-2">
                    ${!schedule.sent ? `
                        <button class="btn btn-sm btn-outline-primary" onclick="editSchedule(${schedule.id})" title="Edit"><i class="bi bi-pencil-square"></i></button>
                        <button class="btn btn-sm btn-outline-success" onclick="sendScheduleNowSingle(${schedule.id})" title="Send Now"><i class="bi bi-send-fill"></i></button>
                    ` : ''}
                    <button class="btn btn-sm btn-outline-danger" onclick="deleteSchedule(${schedule.id})" title="Delete"><i class="bi bi-trash-fill"></i></button>
                </div>
            </div>
        </div>`;

    container.appendChild(item);
}

// Fixed: Button Actions using IndexedDB
async function deleteSchedule(id) {
    if (confirm('Delete this schedule?')) {
        await deleteScheduleFromDB(id);
        renderSchedules();
        showToast('Schedule deleted.', 'info');
    }
}
async function editSchedule(id) {
    const list = await getAllSchedulesMeta();
    const meta = list.find(j => j.id === id);

    if (meta) {
        if (meta.sent) return showToast('Cannot edit sent schedule', 'warning');

        document.getElementById('scheduleTime').value = meta.time;
        document.getElementById('scheduleMessage').value = meta.message;

        // Fetch heavy data to get the recipients back into the text box
        const data = await getScheduleData(id);
        if (data && data.recipients) {
            const textRecips = data.recipients.map(r => r.phone).join('\n');
            document.getElementById('scheduleRecipients').value = textRecips;
        }

        await deleteScheduleFromDB(id);
        showToast('Schedule loaded for editing', 'info');
        renderSchedules();
        document.getElementById('scheduleTime').scrollIntoView({ behavior: 'smooth' });
    }
}

async function sendScheduleNowSingle(jobId) {
    const list = await getAllSchedulesMeta();
    const meta = list.find(s => s.id === jobId);

    if (!meta) return showToast('Schedule not found.', 'error');
    if (confirm(`Send schedule for ${meta.time} now?`)) {

        let activeId = document.getElementById('instance_id')?.value;
        let activeToken = document.getElementById('token')?.value;
        if (!activeId) {
            const saved = JSON.parse(localStorage.getItem('wa_app_config') || '{}');
            activeId = saved.currentInstanceId;
            activeToken = saved.currentToken;
        }

        // Just-in-time fetch
        const heavyData = await getScheduleData(jobId);
        const fullJob = {
            ...meta,
            recipients: heavyData.recipients,
            fileMeta: meta.hasFile ? {
                filename: meta.filename,
                type: heavyData.fileType,
                base64: heavyData.base64
            } : null
        };

        await executeScheduledJob(fullJob, activeId, activeToken);

        meta.sent = true;
        meta.sentAt = new Date().toISOString();
        await updateScheduleMeta(meta);
        await clearHeavyDataAfterSend(jobId); // Cleanup!

        renderSchedules();
    }
}

async function sendScheduleNow() {
    saveLocalSchedule(); // Just verify and save
}
/* ========================================================================== */
/* 10. CONTACT SELECTION COUNTERS                                            */
/* ========================================================================== */

function updateContactSelectionCounters() {
    // Bulk tab counter
    const bulkSelected = document.querySelectorAll('#bulkContactsList input.bulk-contact:checked').length;
    const bulkTotal = document.querySelectorAll('#bulkContactsList input.bulk-contact').length;
    const bulkCounter = document.getElementById('bulkContactCounter');

    if (bulkCounter) {
        bulkCounter.textContent = `${bulkSelected}/${bulkTotal} selected`;
        bulkCounter.className = `badge ${bulkSelected > 0 ? 'bg-primary' : 'bg-secondary'}`;
    }

    // Schedule tab counter
    const scheduleSelected = document.querySelectorAll('#scheduleContactsList input.schedule-contact:checked').length;
    const scheduleTotal = document.querySelectorAll('#scheduleContactsList input.schedule-contact').length;
    const scheduleCounter = document.getElementById('scheduleContactCounter');

    if (scheduleCounter) {
        scheduleCounter.textContent = `${scheduleSelected}/${scheduleTotal}`;
        scheduleCounter.className = `badge ${scheduleSelected > 0 ? 'bg-primary' : 'bg-secondary'}`;
    }
}

function createBulkContactsUI() {
    const toggleBtn = document.getElementById('toggleBulkContacts');
    if (toggleBtn) toggleBtn.innerHTML = 'Select from Saved Contacts';

    const selectAll = document.getElementById('selectAllBulk');
    if (selectAll) {
        selectAll.addEventListener('change', e => {
            document.querySelectorAll('#bulkContactsList input[type="checkbox"]').forEach(checkbox => {
                if (checkbox.id !== 'selectAllBulk') {
                    checkbox.checked = e.target.checked;
                }
            });
            updateContactSelectionCounters();
        });
    }
}

function createScheduleContactsUI() {
    const toggleBtn = document.getElementById('toggleScheduleContacts');
    if (toggleBtn) toggleBtn.innerHTML = 'Select from Saved Contacts';

    const selectAll = document.getElementById('selectAllSchedule');
    if (selectAll) {
        selectAll.addEventListener('change', e => {
            document.querySelectorAll('#scheduleContactsList input[type="checkbox"]').forEach(checkbox => {
                if (checkbox.id !== 'selectAllSchedule') {
                    checkbox.checked = e.target.checked;
                }
            });
            updateContactSelectionCounters();
        });
    }
}

function loadBulkContactsList() {
    const contacts = JSON.parse(localStorage.getItem('wa_contacts') || '[]');
    const container = document.getElementById('bulkContactsList');
    if (!container) return;

    container.innerHTML = '';

    if (contacts.length === 0) {
        container.innerHTML = '<div class="text-muted p-2">No contacts saved.</div>';
        return;
    }

    contacts.forEach(c => {
        const div = document.createElement('div');
        div.className = 'form-check mb-1';
        div.innerHTML = `
            <input type="checkbox" class="form-check-input bulk-contact" 
                   data-phone="${escapeHtml(c.phone)}" data-name="${escapeHtml(c.name)}">
            <label class="form-check-label">
                ${escapeHtml(c.name)} (${escapeHtml(c.phone)})
            </label>`;
        container.appendChild(div);
    });

    updateContactSelectionCounters();
    applyRealTimeFilter('searchBulkContacts', 'bulkContactsList');
}

function loadScheduleContactsList() {
    const contacts = JSON.parse(localStorage.getItem('wa_contacts') || '[]');
    const container = document.getElementById('scheduleContactsList');
    if (!container) return;

    container.innerHTML = '';

    if (contacts.length === 0) {
        container.innerHTML = '<div class="text-muted p-2">No contacts saved.</div>';
        return;
    }

    contacts.forEach(c => {
        const div = document.createElement('div');
        div.className = 'form-check mb-1';
        div.innerHTML = `
            <input type="checkbox" class="form-check-input schedule-contact" 
                   data-phone="${escapeHtml(c.phone)}" data-name="${escapeHtml(c.name)}">
            <label class="form-check-label">
                ${escapeHtml(c.name)} (${escapeHtml(c.phone)})
            </label>`;
        container.appendChild(div);
    });

    updateContactSelectionCounters();
    applyRealTimeFilter('searchScheduleContacts', 'scheduleContactsList');
}

/* ========================================================================== */
/* REAL TIME CLOCK FUNCTION                                                   */
/* ========================================================================== */

function updateRealTimeClock() {
    const now = new Date();

    // Format time (HH:MM:SS)
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');
    const timeString = `${hours}:${minutes}:${seconds}`;

    // Format date (Day, DD Month YYYY)
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    const dayName = days[now.getDay()];
    const day = String(now.getDate()).padStart(2, '0');
    const month = months[now.getMonth()];
    const year = now.getFullYear();
    const dateString = `${dayName}, ${day} ${month} ${year}`;

    // Update DOM elements
    const clockTime = document.getElementById('clockTime');
    const clockDate = document.getElementById('clockDate');

    if (clockTime) {
        clockTime.textContent = timeString;
    }

    if (clockDate) {
        clockDate.textContent = dateString;
    }
}

// Initialize and start the clock
function initializeRealTimeClock() {
    // Update immediately
    updateRealTimeClock();

    // Update every second
    setInterval(updateRealTimeClock, 1000);

    console.log("Real-time clock initialized");
}

/* ========================================================================== */
/* 11. AUTO-RESPONDER SYSTEM - FIXED RENEWAL/EXPIRY MESSAGES                 */
/* ========================================================================== */

/**
 * Initialize auto-responder for renewal/expiry messages
 */
function initializeAutoResponder() {
    // Clear any existing interval
    if (window.autoResponderInterval) {
        clearInterval(window.autoResponderInterval);
    }

    // Run auto-responder every 60 seconds
    window.autoResponderInterval = setInterval(() => {
        if (isAutoResponderRunning) return;
        isAutoResponderRunning = true;

        try {
            checkAndSendAutomatedMessages();
        } catch (error) {
            console.error("Auto-responder error:", error);
        } finally {
            isAutoResponderRunning = false;
        }
    }, 60000); // 60 seconds

    console.log("Auto-responder initialized (checking every 60 seconds)");
}

/**
 * Generate watermark text based on configuration
 */
function generateWatermarkText(name, phone) {
    const format = appConfig.watermarkFormat || 'name_phone';
    const customText = appConfig.watermarkText || '{name} - {phone}';

    switch (format) {
        case 'name':
            return name;
        case 'phone':
            return phone;
        case 'name_phone':
            return `${name} - ${phone}`;
        case 'custom':
            return customText
                .replace(/{name}/g, name)
                .replace(/{phone}/g, phone);
        default:
            return `${name} - ${phone}`;
    }
}

async function triggerAutomatedNotification(type, contact) {
    console.log(`[Auto-Trigger] Attempting ${type} notification for ${contact.phone}`);

    const settings = JSON.parse(localStorage.getItem('wa_notification_settings') || '{}');

    let messageTemplate = '';

    if (type === 'start') {
        messageTemplate = settings.startMsg;
    } else if (type === 'renewal') {
        messageTemplate = settings.renewalMsg;
    } else if (type === 'end') {
        messageTemplate = settings.endMsg;
    }

    if (!messageTemplate || messageTemplate.trim() === '') {
        console.log(`[Auto-Trigger] Skipped '${type}' notification: No template found.`);
        return false;
    }

    // ENHANCED PLACEHOLDER REPLACEMENT
    const finalMessage = messageTemplate
        .replace(/{name}/g, contact.name || 'Customer')
        .replace(/{start}/g, contact.startDate || 'N/A')
        .replace(/{end}/g, contact.endDate || 'N/A')
        .replace(/{phone}/g, contact.phone)
        .replace(/{date}/g, getLocalDateString())
        .replace(/{time}/g, new Date().toLocaleTimeString());

    console.log(`[Auto-Trigger] Sending ${type} notification to ${contact.phone}: "${finalMessage.substring(0, 50)}..."`);

    // USE THE SAME SENDING LOGIC AS REGULAR MESSAGES
    const payload = buildPayload(contact.phone, finalMessage, '', '');

    // Show immediate UI feedback
    showToast(`Sending ${type} notification to ${contact.name || contact.phone}`, 'info');

    const success = await postSendAndHandleResponse(payload, '', finalMessage, contact.phone, { innerHTML: '' });

    if (success) {
        console.log(`[Auto-Trigger] ✅ Successfully sent '${type}' notification to ${contact.phone}`);

        // Update ALL contacts with the same phone number
        const contacts = JSON.parse(localStorage.getItem('wa_contacts') || '[]');
        let anyUpdated = false;

        for (let i = 0; i < contacts.length; i++) {
            if (contacts[i].phone === contact.phone) {
                // Set appropriate properties based on notification type
                if (type === 'start') {
                    contacts[i].startNotified = true;
                    contacts[i].startNotifiedAt = new Date().toISOString();
                } else if (type === 'renewal') {
                    contacts[i].renewalNotified = true;
                    contacts[i].renewalNotifiedAt = new Date().toISOString();
                } else if (type === 'end') {
                    contacts[i].notifiedEnd = true;
                    contacts[i].notifiedAt = new Date().toISOString();
                    contacts[i].expiryStatus = contact.endDate === getLocalDateString() ? 'notified_today' : 'notified_past_due';
                }
                anyUpdated = true;
            }
        }

        if (anyUpdated) {
            localStorage.setItem('wa_contacts', JSON.stringify(contacts));

            // FIX: Update UI immediately
            loadContacts();
        }

        logActivity({
            type: 'automation',
            message: `✅ Sent ${type} notification to ${contact.name || contact.phone}`,
            success: true,
            phone: contact.phone,
            notificationType: type
        });
        return true;
    } else {
        console.error(`[Auto-Trigger] ❌ Failed to send '${type}' notification to ${contact.phone}`);

        logActivity({
            type: 'automation',
            message: `❌ Failed to send ${type} notification to ${contact.name || contact.phone}`,
            success: false,
            phone: contact.phone,
            notificationType: type
        });
        return false;
    }
}

/**
 * Check and send automated messages for renewal/expiry
 */
async function checkAndSendAutomatedMessages() {
    console.log("[Auto-Responder] Starting automated message check...");

    const contacts = JSON.parse(localStorage.getItem('wa_contacts') || '[]');
    const settings = JSON.parse(localStorage.getItem('wa_notification_settings') || '{}');

    console.log(`[Auto-Responder] Checking ${contacts.length} contacts`);
    console.log(`[Auto-Responder] Settings: Start=${!!settings.startMsg}, Renewal=${!!settings.renewalMsg}, End=${!!settings.endMsg}`);

    const today = getLocalDateString();
    const todayDate = new Date(today);
    todayDate.setHours(0, 0, 0, 0); // Normalize to start of day

    console.log(`[Auto-Responder] Today's date: ${today}`);

    let updated = false;

    for (let i = 0; i < contacts.length; i++) {
        const contact = contacts[i];

        // ============================================================
        // 1. CHECK FOR START DATE NOTIFICATIONS (WELCOME MESSAGES)
        // ============================================================
        if (contact.startDate) {
            const startDate = new Date(contact.startDate);
            startDate.setHours(0, 0, 0, 0);

            if (startDate.getTime() === todayDate.getTime() &&
                !contact.startNotified &&
                settings.startMsg) {
                console.log(`[Auto-Responder] 📧 Sending welcome notification to ${contact.name} (Start date: ${contact.startDate})`);
                try {
                    const success = await triggerAutomatedNotification('start', contact);
                    if (success) {
                        contacts[i].startNotified = true;
                        contacts[i].startNotifiedAt = new Date().toISOString();
                        updated = true;
                        console.log(`[Auto-Responder] ✅ Welcome notification sent to ${contact.name}`);
                    }
                    await sleep(1000);
                } catch (error) {
                    console.error(`[Auto-Responder] ❌ Error sending welcome:`, error);
                }
            }
        }

        // ============================================================
        // 2. CHECK FOR END DATE NOTIFICATIONS (EXPIRY MESSAGES)
        // ============================================================
        if (contact.endDate) {
            // Parse end date and normalize to start of day for comparison
            const endDate = new Date(contact.endDate);
            endDate.setHours(0, 0, 0, 0);

            // Check if TODAY is the end date (EXACT MATCH) - EXPIRY MESSAGE
            if (endDate.getTime() === todayDate.getTime() &&
                !contact.notifiedEnd &&
                settings.endMsg) {
                console.log(`[Auto-Responder] 📧 Sending expiry notification to ${contact.name} (Ends today: ${contact.endDate})`);

                try {
                    const success = await triggerAutomatedNotification('end', contact);
                    if (success) {
                        contacts[i].notifiedEnd = true;
                        contacts[i].notifiedAt = new Date().toISOString();
                        contacts[i].expiryStatus = 'notified_today';
                        updated = true;
                        console.log(`[Auto-Responder] ✅ Expiry notification sent to ${contact.name}`);
                    }
                    await sleep(1000);
                } catch (error) {
                    console.error(`[Auto-Responder] ❌ Error sending expiry notification to ${contact.name}:`, error);
                }
            }

            // Check for PAST DUE notifications (expired yesterday or earlier but not notified)
            else if (endDate.getTime() < todayDate.getTime() &&
                !contact.notifiedEnd &&
                settings.endMsg) {
                console.log(`[Auto-Responder] 📧 Sending PAST DUE expiry notification to ${contact.name} (Expired on ${contact.endDate})`);

                try {
                    const success = await triggerAutomatedNotification('end', contact);
                    if (success) {
                        contacts[i].notifiedEnd = true;
                        contacts[i].notifiedAt = new Date().toISOString();
                        contacts[i].expiryStatus = 'notified_past_due';
                        updated = true;
                        console.log(`[Auto-Responder] ✅ Past due notification sent to ${contact.name}`);
                    }
                    await sleep(1000);
                } catch (error) {
                    console.error(`[Auto-Responder] ❌ Error sending past due notification to ${contact.name}:`, error);
                }
            }
        }
    }

    if (updated) {
        localStorage.setItem('wa_contacts', JSON.stringify(contacts));
        console.log(`[Auto-Responder] Updated contacts in storage`);

        // CRITICAL FIX: RELOAD THE CONTACTS LIST TO SHOW UPDATED STATUS
        loadContacts();
    } else {
        console.log("[Auto-Responder] No notifications sent");
    }

    console.log("[Auto-Responder] Automated message check completed");
}

/* ========================================================================== */
/* 12. ACTIVITY LOGGING                                                       */
/* ========================================================================== */

/**
 * Fixed: Log activity with duplicate prevention
 */
function logActivity(activity) {
    const activities = JSON.parse(localStorage.getItem('wa_activities') || '[]');

    // Add timestamp if not provided
    if (!activity.time) {
        activity.time = new Date().toLocaleString();
    }

    // Add unique ID
    activity.id = Date.now() + Math.random().toString(36).substr(2, 9);

    activities.unshift(activity);

    // Keep only last 1000 activities
    if (activities.length > 1000) {
        activities.length = 1000;
    }

    localStorage.setItem('wa_activities', JSON.stringify(activities));

    // Update dashboard if active
    if (document.getElementById('view-dashboard')?.classList.contains('active')) {
        renderDashboard();
    }

    // Update logs if active
    if (document.getElementById('view-logs')?.classList.contains('active')) {
        renderLogs();
    }
}

/* ========================================================================== */
/* 13. TEMPLATES MANAGEMENT                                                   */
/* ========================================================================== */

function loadTemplates() {
    const templates = JSON.parse(localStorage.getItem('wa_templates') || '[]');
    const container = document.getElementById('templatesList');
    if (!container) return;

    container.innerHTML = '';

    if (!templates.length) {
        container.innerHTML = '<div class="text-muted small text-center p-3">No templates saved.</div>';
        return;
    }

    templates.forEach((tpl, i) => {
        const div = document.createElement('div');
        div.className = 'mb-2 p-2 border rounded bg-white';
        div.innerHTML = `
            <div class="d-flex justify-content-between align-items-center">
                <span class="text-truncate" style="max-width: 60%;">${escapeHtml(tpl)}</span>
                <div class="btn-group">
                    <button class="btn btn-sm btn-outline-primary" onclick="useTemplate(${i})">
                        <i class="bi bi-arrow-right"></i> Use
                    </button>
                    <button class="btn btn-sm btn-outline-danger" onclick="deleteTemplate(${i})">
                        <i class="bi bi-trash"></i>
                    </button>
                </div>
            </div>`;
        container.appendChild(div);
    });
}

function saveTemplate() {
    const text = document.getElementById('templateText').value.trim();
    if (!text) {
        showToast('Template cannot be empty.', 'warning');
        return;
    }

    const templates = JSON.parse(localStorage.getItem('wa_templates') || '[]');
    templates.push(text);
    localStorage.setItem('wa_templates', JSON.stringify(templates));

    document.getElementById('templateText').value = '';
    loadTemplates();
    showToast('Template saved.', 'success');
}

// UPGRADED: Now shows a popup to select the destination
function useTemplate(i) {
    // Remove existing modal if it's already in the DOM
    const existingModal = document.getElementById('templateTargetModal');
    if (existingModal) existingModal.remove();

    // Build the popup modal HTML
    const html = `
        <div class="modal fade" id="templateTargetModal" tabindex="-1">
            <div class="modal-dialog modal-sm modal-dialog-centered">
                <div class="modal-content shadow">
                    <div class="modal-header bg-light">
                        <h6 class="modal-title mb-0"><i class="bi bi-file-text text-primary"></i> Apply Template</h6>
                        <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
                    </div>
                    <div class="modal-body p-4">
                        <p class="text-center text-muted small mb-3">Where do you want to use this message?</p>
                        <div class="d-grid gap-2">
                            <button class="btn btn-outline-primary text-start" onclick="applyTemplateToTarget(${i}, 'send')">
                                <i class="bi bi-send me-2"></i> Single Send
                            </button>
                            <button class="btn btn-outline-success text-start" onclick="applyTemplateToTarget(${i}, 'bulk')">
                                <i class="bi bi-broadcast me-2"></i> Bulk Sender
                            </button>
                            <button class="btn btn-outline-warning text-dark text-start" onclick="applyTemplateToTarget(${i}, 'scheduler')">
                                <i class="bi bi-calendar-event me-2"></i> Scheduler
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        </div>`;

    // Append to body and show
    document.body.insertAdjacentHTML('beforeend', html);
    const modal = new bootstrap.Modal(document.getElementById('templateTargetModal'));
    modal.show();
}

// NEW: Routes the template text to the correct tab and text box
function applyTemplateToTarget(index, target) {
    const templates = JSON.parse(localStorage.getItem('wa_templates') || '[]');
    const text = templates[index];
    
    if (!text) return;

    // Hide the modal smoothly
    const modalEl = document.getElementById('templateTargetModal');
    const modal = bootstrap.Modal.getInstance(modalEl);
    if (modal) modal.hide();

    // Route the text to the correct input box and switch the view
    let targetName = "";
    if (target === 'send') {
        document.getElementById('singleMessage').value = text;
        showView('send');
        targetName = "Single Send";
        
        // Force the mode to "Message" or "Both" if it was on "File Only"
        const bothRadio = document.querySelector('input[name="sendMode"][value="both"]');
        if (bothRadio) {
            bothRadio.checked = true;
            updateSendModeUI('both');
        }

    } else if (target === 'bulk') {
        document.getElementById('bulkMessage').value = text;
        showView('bulk');
        targetName = "Bulk Sender";

    } else if (target === 'scheduler') {
        document.getElementById('scheduleMessage').value = text;
        showView('scheduler');
        targetName = "Scheduler";
    }

    showToast(`Template loaded to ${targetName}.`, 'success');
}

function deleteTemplate(i) {
    if (!confirm('Delete this template?')) return;

    const templates = JSON.parse(localStorage.getItem('wa_templates') || '[]');
    templates.splice(i, 1);
    localStorage.setItem('wa_templates', JSON.stringify(templates));
    loadTemplates();
    showToast('Template deleted.', 'info');
}

/* ========================================================================== */
/* 14. LOGS MANAGEMENT                                                        */
/* ========================================================================== */

function pushLog(entry) {
    const logs = JSON.parse(localStorage.getItem('wa_logs') || '[]');
    logs.unshift({
        time: new Date().toLocaleString(),
        to: entry.to,
        filename: entry.filename || '',
        message: entry.message || '',
        status: entry.status || 'unknown',
        ...entry
    });

    // Keep only last 500 logs
    const trimmedLogs = logs.slice(0, 500);
    localStorage.setItem('wa_logs', JSON.stringify(trimmedLogs));

    renderLogs();
    updateMessageCount();
}

function renderLogs() {
    const logs = JSON.parse(localStorage.getItem('wa_logs') || '[]');
    const activities = JSON.parse(localStorage.getItem('wa_activities') || '[]');
    const container = document.getElementById('logsTable');

    if (!container) return;

    container.innerHTML = `
        <div class="card">
            <div class="card-header">
                <ul class="nav nav-tabs" id="logsTabs">
                    <li class="nav-item">
                        <button class="nav-link active" onclick="showLogsTab('message')">
                            Message Logs (${logs.length})
                        </button>
                    </li>
                    <li class="nav-item">
                        <button class="nav-link" onclick="showLogsTab('activity')">
                            Activity Logs (${activities.length})
                        </button>
                    </li>
                    <li class="nav-item">
                        <button class="nav-link" onclick="showLogsTab('system')">
                            System Info
                        </button>
                    </li>
                </ul>
            </div>
            <div class="card-body">
                <div id="messageLogsTab" class="tab-pane active">
                    ${renderMessageLogsContent(logs)}
                </div>
                <div id="activityLogsTab" class="tab-pane" style="display:none">
                    ${renderActivityLogsContent(activities)}
                </div>
                <div id="systemLogsTab" class="tab-pane" style="display:none">
                    ${renderSystemLogsContent()}
                </div>
            </div>
        </div>`;
}

function showLogsTab(tabName) {
    // Hide all tabs
    document.getElementById('messageLogsTab')?.style?.setProperty('display', 'none');
    document.getElementById('activityLogsTab')?.style?.setProperty('display', 'none');
    document.getElementById('systemLogsTab')?.style?.setProperty('display', 'none');

    // Remove active class from all tabs
    document.querySelectorAll('#logsTabs .nav-link').forEach(link => {
        link.classList.remove('active');
    });

    // Show selected tab
    const tabElement = document.getElementById(`${tabName}LogsTab`);
    if (tabElement) {
        tabElement.style.display = 'block';
    }

    // Add active class to clicked tab
    event.target.classList.add('active');
}

function renderMessageLogsContent(logs) {
    if (!logs.length) {
        return '<div class="text-muted text-center p-4">No message logs available.</div>';
    }

    let html = `
        <div class="table-responsive">
            <table class="table table-sm table-hover align-middle">
                <thead class="table-light">
                    <tr>
                        <th style="width: 15%">Time</th>
                        <th style="width: 15%">To</th>
                        <th style="width: 45%">Details</th>
                        <th style="width: 10%">Status</th>
                        <th style="width: 15%">Actions</th>
                    </tr>
                </thead>
                <tbody>`;

    logs.forEach((log, index) => {
        const isFailed = log.status !== 'sent';
        const statusBadge = !isFailed
            ? '<span class="badge bg-success"><i class="bi bi-check-all"></i> Sent</span>'
            : `<span class="badge bg-danger"><i class="bi bi-x-circle"></i> ${log.status === 'error' ? 'Error' : 'Failed'}</span>`;

        const typeIcon = log.filename
            ? `<i class="bi bi-paperclip text-primary" title="${escapeHtml(log.filename)}"></i>`
            : '<i class="bi bi-chat-text text-secondary" title="Text Message"></i>';

        // Keep message short for UI clarity
        const shortMsg = (log.message || '').substring(0, 60) + ((log.message || '').length > 60 ? '...' : '');

        // Build the Error Info Block (Only shows if failed)
        let errorHtml = '';
        if (isFailed) {
            let reason = log.failedReason || log.error || 'Unknown API Error';
            if (typeof reason === 'object') reason = JSON.stringify(reason);

            errorHtml = `
                <div class="mt-1 p-2 rounded bg-danger bg-opacity-10 border-start border-danger border-3 text-danger small" style="line-height: 1.3;">
                    <strong><i class="bi bi-exclamation-triangle-fill"></i> Reason:</strong> ${escapeHtml(reason)}
                </div>`;
        }

        html += `
            <tr>
                <td class="small text-muted">${log.time}</td>
                <td class="fw-bold">${escapeHtml(log.to)}</td>
                <td>
                    <div class="text-dark mb-1">${typeIcon} ${escapeHtml(shortMsg || '(No text content)')}</div>
                    ${errorHtml}
                </td>
                <td>${statusBadge}</td>
                <td>
                    <div class="btn-group">
                        <button class="btn btn-sm btn-outline-primary" onclick="resendFromLog(${index})" title="Resend">
                            <i class="bi bi-arrow-repeat"></i>
                        </button>
                        <button class="btn btn-sm btn-outline-danger" onclick="deleteLogEntry(${index})" title="Delete">
                            <i class="bi bi-trash"></i>
                        </button>
                    </div>
                </td>
            </tr>`;
    });

    html += `
                </tbody>
            </table>
        </div>
        <div class="mt-3 d-flex flex-wrap gap-2 justify-content-between">
            <div>
                <button class="btn btn-sm btn-outline-primary" onclick="exportLogsCsv()">
                    <i class="bi bi-download"></i> Export CSV
                </button>
                <button class="btn btn-sm btn-outline-warning" onclick="exportFailedNumbers()">
                    <i class="bi bi-exclamation-triangle"></i> Export Failed Numbers
                </button>
            </div>
            <button class="btn btn-sm btn-outline-danger" onclick="clearLogs()">
                <i class="bi bi-trash"></i> Clear All Logs
            </button>
        </div>`;

    return html;
}


function renderActivityLogsContent(activities) {
    if (!activities.length) {
        return '<div class="text-muted text-center p-4">No activity logs available.</div>';
    }

    let html = `
        <div class="table-responsive">
            <table class="table table-sm table-hover align-middle">
                <thead class="table-light">
                    <tr>
                        <th style="width: 15%">Time</th>
                        <th style="width: 10%">Type</th>
                        <th style="width: 50%">Event Description</th>
                        <th style="width: 25%">Metrics / Details</th>
                    </tr>
                </thead>
                <tbody>`;

    activities.slice(0, 50).forEach((act) => {
        // Highlight message based on success/fail context
        let msgClass = "text-dark";
        if (act.success === false) msgClass = "text-danger fw-bold";

        // Format Metrics nicely
        let metricsHtml = '';
        if (act.recipients) metricsHtml += `<span class="badge bg-secondary me-1"><i class="bi bi-people"></i> ${act.recipients}</span>`;
        if (act.success !== undefined && act.type !== 'system' && act.type !== 'contact') {
            metricsHtml += `<span class="badge bg-success me-1"><i class="bi bi-check"></i> ${act.success}</span>`;
        }
        if (act.failed) {
            metricsHtml += `<span class="badge bg-danger text-white"><i class="bi bi-x"></i> ${act.failed} Failed</span>`;
        }

        html += `
            <tr>
                <td class="small text-muted">${act.time || ''}</td>
                <td><span class="badge bg-${getActivityBadgeColor(act.type)}">${act.type || 'Unknown'}</span></td>
                <td>
                    <div class="${msgClass} text-truncate" style="max-width: 400px;" title="${escapeHtml(act.message || '')}">
                        ${escapeHtml(act.message || '')}
                    </div>
                </td>
                <td>
                    <div>${metricsHtml}</div>
                    ${act.jobId ? `<div class="small text-muted mt-1">Job: ${act.jobId}</div>` : ''}
                </td>
            </tr>`;
    });

    html += `
                </tbody>
            </table>
        </div>
        ${activities.length > 50 ? `
            <div class="alert alert-info py-2 d-flex justify-content-between align-items-center">
                <span>Showing 50 of ${activities.length} activities.</span>
                <button class="btn btn-sm btn-primary" onclick="showAllActivity()">View All</button>
            </div>
        ` : ''}
        <div class="mt-3">
            <button class="btn btn-sm btn-outline-primary" onclick="exportActivityCSV()">
                <i class="bi bi-download"></i> Export Activity CSV
            </button>
        </div>`;

    return html;
}

function renderSystemLogsContent() {
    const instances = JSON.parse(localStorage.getItem('wa_instances') || '[]');
    const activeInstance = getActiveInstance();

    return `
        <div class="row">
            <div class="col-md-6">
                <div class="card mb-3">
                    <div class="card-header">System Configuration</div>
                    <div class="card-body">
                        <table class="table table-sm">
                            <tr><td>Base Delay</td><td>${appConfig.rateDelay}ms</td></tr>
                            <tr><td>Jitter Enabled</td><td>${appConfig.randomizeDelay ? 'Yes' : 'No'}</td></tr>
                            <tr><td>Jitter Range</td><td>${appConfig.jitterRange}ms</td></tr>
                            <tr><td>File Size Limit</td><td>${appConfig.maxFileSizeMB}MB</td></tr>
                            <tr><td>Batch Size</td><td>${appConfig.batchSize}</td></tr>
                            <tr><td>Batch Delay</td><td>${appConfig.batchDelay / 1000}s</td></tr>
                            <tr><td>Parallel Limit</td><td>${appConfig.parallelLimit}</td></tr>
                            <tr><td>Max Contacts/Batch</td><td>${appConfig.maxContactsPerBatch}</td></tr>
                            <tr><td>Progressive Delay</td><td>${appConfig.enableProgressiveDelay ? 'Yes' : 'No'}</td></tr>
                            <tr><td>Master PC</td><td>${appConfig.isMasterPC ? 'Yes' : 'No'}</td></tr>
                            <tr><td>Master IP</td><td>${appConfig.masterIP || 'Not set'}</td></tr>
                            <tr><td>Watermark Enabled</td><td>${appConfig.enableWatermarking ? 'Yes' : 'No'}</td></tr>
                            <tr><td>Watermark Format</td><td>${appConfig.watermarkFormat || 'name_phone'}</td></tr>
                        </table>
                    </div>
                </div>
            </div>
            <div class="col-md-6">
                <div class="card mb-3">
                    <div class="card-header">Active Instance</div>
                    <div class="card-body">
                        <table class="table table-sm">
                            <tr><td>Name</td><td>${activeInstance.name}</td></tr>
                            <tr><td>ID</td><td>${activeInstance.id}</td></tr>
                            <tr><td>Endpoint</td><td>${activeInstance.endpoint}</td></tr>
                            <tr><td>Token</td><td>${activeInstance.token ? '***' + activeInstance.token.slice(-4) : 'Not Set'}</td></tr>
                        </table>
                    </div>
                </div>
                <div class="card">
                    <div class="card-header">Storage Information</div>
                    <div class="card-body">
                        <table class="table table-sm">
                            <tr><td>Contacts</td><td>${JSON.parse(localStorage.getItem('wa_contacts') || '[]').length}</td></tr>
                            <tr><td>Templates</td><td>${JSON.parse(localStorage.getItem('wa_templates') || '[]').length}</td></tr>
                            <tr><td>Schedules</td><td>${JSON.parse(localStorage.getItem('wa_schedules') || '[]').length}</td></tr>
                            <tr><td>Message Logs</td><td>${JSON.parse(localStorage.getItem('wa_logs') || '[]').length}</td></tr>
                            <tr><td>Activity Logs</td><td>${JSON.parse(localStorage.getItem('wa_activities') || '[]').length}</td></tr>
                        </table>
                    </div>
                </div>
            </div>
        </div>`;
}

function resendFromLog(logIndex) {
    const logs = JSON.parse(localStorage.getItem('wa_logs') || '[]');
    const log = logs[logIndex];

    if (!log) {
        showToast('Log entry not found', 'error');
        return;
    }

    if (confirm(`Resend message to ${log.to}?`)) {
        // For resending, we need to reconstruct the payload
        // Since we don't store the full message/file in logs, we'll just send a message
        const payload = buildPayload(log.to, log.message || 'Resent message', '', '');
        postSendAndHandleResponse(payload, '', log.message || 'Resent message', log.to, null);
        showToast(`Resending to ${log.to}...`, 'info');
    }
}

function deleteLogEntry(logIndex) {
    if (!confirm('Delete this log entry?')) return;

    const logs = JSON.parse(localStorage.getItem('wa_logs') || '[]');
    logs.splice(logIndex, 1);
    localStorage.setItem('wa_logs', JSON.stringify(logs));
    renderLogs();
    showToast('Log entry deleted', 'info');
}

function exportLogsCsv() {
    const logs = JSON.parse(localStorage.getItem('wa_logs') || '[]');
    if (!logs.length) {
        showToast('No logs to export', 'info');
        return;
    }

    const headers = ['Timestamp', 'To', 'Filename', 'Message', 'Status'];
    const rows = logs.map(l => [
        l.time,
        l.to,
        l.filename || '',
        (l.message || '').replace(/"/g, '""').substring(0, 100),
        l.status
    ]);

    const csvContent = [headers, ...rows]
        .map(row => row.map(cell => `"${cell}"`).join(','))
        .join('\n');

    const blob = new Blob([csvContent], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `whatsapp_logs_${Date.now()}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);

    showToast('Logs exported as CSV', 'success');
}
/**
 * Scans logs for failed messages and exports a clean list of unique phone numbers
 */
function exportFailedNumbers() {
    const logs = JSON.parse(localStorage.getItem('wa_logs') || '[]');

    // Filter for logs that are not 'sent'
    const failedLogs = logs.filter(log => log.status !== 'sent');

    if (failedLogs.length === 0) {
        showToast('Great news! There are no failed numbers to export.', 'success');
        return;
    }

    // Extract unique phone numbers using a Set
    const uniqueFailedNumbers = [...new Set(failedLogs.map(log => log.to))];

    // Create a plain text format (one number per line) - perfect for copy/pasting
    const textContent = uniqueFailedNumbers.join('\n');

    // Create the downloadable file
    const blob = new Blob([textContent], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `failed_numbers_${new Date().toISOString().slice(0, 10)}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);

    // Log the action
    logActivity({
        type: 'system',
        message: `Exported ${uniqueFailedNumbers.length} failed numbers`,
        success: true
    });

    showToast(`Exported ${uniqueFailedNumbers.length} failed numbers ready for retry!`, 'success');
}
function clearLogs() {
    if (!confirm('Clear entire log history?')) return;

    localStorage.removeItem('wa_logs');
    renderLogs();
    showToast('Logs cleared.', 'info');

    logActivity({
        type: 'system',
        message: 'Cleared all message logs',
        success: true
    });
}

function showAllActivity() {
    const activities = JSON.parse(localStorage.getItem('wa_activities') || '[]');

    let html = `
        <div class="modal fade" id="activityModal" tabindex="-1">
            <div class="modal-dialog modal-xl">
                <div class="modal-content">
                    <div class="modal-header">
                        <h5 class="modal-title">All Activities (${activities.length})</h5>
                        <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
                    </div>
                    <div class="modal-body">
                        <div class="table-responsive">
                            <table class="table table-sm">
                                <thead>
                                    <tr>
                                        <th>Time</th>
                                        <th>Type</th>
                                        <th>Message</th>
                                        <th>Recipients</th>
                                        <th>Success</th>
                                        <th>Failed</th>
                                        <th>Job ID</th>
                                    </tr>
                                </thead>
                                <tbody>`;

    activities.forEach(act => {
        html += `
            <tr>
                <td>${act.time}</td>
                <td><span class="badge bg-${getActivityBadgeColor(act.type)}">${act.type}</span></td>
                <td>${escapeHtml(act.message || '')}</td>
                <td>${act.recipients || ''}</td>
                <td>${act.success || ''}</td>
                <td>${act.failed || ''}</td>
                <td>${act.jobId || ''}</td>
            </tr>`;
    });

    html += `
                                </tbody>
                            </table>
                        </div>
                    </div>
                    <div class="modal-footer">
                        <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Close</button>
                        <button type="button" class="btn btn-primary" onclick="exportActivityCSV()">
                            <i class="bi bi-download"></i> Export CSV
                        </button>
                    </div>
                </div>
            </div>
        </div>`;

    // Remove existing modal
    const existingModal = document.getElementById('activityModal');
    if (existingModal) existingModal.remove();

    // Add modal to body
    document.body.insertAdjacentHTML('beforeend', html);

    // Show modal
    const modal = new bootstrap.Modal(document.getElementById('activityModal'));
    modal.show();
}

function exportActivityCSV() {
    const activities = JSON.parse(localStorage.getItem('wa_activities') || '[]');
    if (!activities.length) {
        showToast('No activity to export', 'info');
        return;
    }

    const headers = ['Timestamp', 'Type', 'Message', 'Recipients', 'Success', 'Failed', 'Job ID'];
    const rows = activities.map(act => [
        act.time,
        act.type,
        (act.message || '').replace(/"/g, '""'),
        act.recipients || '',
        act.success || '',
        act.failed || '',
        act.jobId || ''
    ]);

    const csvContent = [headers, ...rows]
        .map(row => row.map(cell => `"${cell}"`).join(','))
        .join('\n');

    const blob = new Blob([csvContent], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `whatsapp_activity_${Date.now()}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);

    showToast('Activity log exported as CSV', 'success');
}

/* ========================================================================== */
/* 15. ADMIN FUNCTIONS                                                        */
/* ========================================================================== */

/* ========================================================================== */
/* 15. ADMIN FUNCTIONS                                                        */
/* ========================================================================== */

// Global variable to track if we are editing an instance
var editingInstanceId = null;

function loadAdminSettings() {
    // Delay settings
    const delayRange = document.getElementById('adminDelayRange');
    const delayDisplay = document.getElementById('adminDelayDisplay');

    if (delayRange && delayDisplay) {
        delayRange.value = appConfig.rateDelay;
        delayDisplay.textContent = `${appConfig.rateDelay}ms`;
    }

    // Jitter toggle
    const jitterToggle = document.getElementById('adminJitterToggle');
    if (jitterToggle) {
        jitterToggle.checked = appConfig.randomizeDelay;
    }

    // File size settings
    const sizeSlider = document.getElementById('adminFileSizeRange');
    const sizeDisplay = document.getElementById('adminFileSizeDisplay');

    if (sizeSlider && sizeDisplay) {
        sizeSlider.value = appConfig.maxFileSizeMB;
        sizeDisplay.textContent = `${appConfig.maxFileSizeMB}MB`;
    }

    // Master PC settings
    const masterToggle = document.getElementById('adminMasterToggle');
    const ipInput = document.getElementById('adminMasterIP');

    if (masterToggle && ipInput) {
        masterToggle.checked = appConfig.isMasterPC;
        ipInput.value = appConfig.masterIP || '';
    }

    // Enterprise settings
    const batchSize = document.getElementById('adminBatchSize');
    const batchDelay = document.getElementById('adminBatchDelay');
    const parallelLimit = document.getElementById('adminParallelLimit');
    const maxContacts = document.getElementById('adminMaxContacts');
    const safetyToggle = document.getElementById('adminSafetyToggle');
    const watermarkToggle = document.getElementById('adminWatermarkToggle');
    const watermarkFormat = document.getElementById('adminWatermarkFormat');
    const watermarkText = document.getElementById('adminWatermarkText');
    const poolToggle = document.getElementById('adminPoolToggle');
    const poolMode = document.getElementById('adminPoolMode');
    const poolChunk = document.getElementById('adminPoolChunkSize');

    if (batchSize) batchSize.value = appConfig.batchSize;
    if (batchDelay) batchDelay.value = appConfig.batchDelay / 1000;
    if (parallelLimit) parallelLimit.value = appConfig.parallelLimit;
    if (maxContacts) maxContacts.value = appConfig.maxContactsPerBatch;
    if (safetyToggle) safetyToggle.checked = appConfig.enableProgressiveDelay;
    if (watermarkToggle) watermarkToggle.checked = appConfig.enableWatermarking;
    if (watermarkFormat) watermarkFormat.value = appConfig.watermarkFormat || 'name_phone';
    if (watermarkText) watermarkText.value = appConfig.watermarkText || '{name} - {phone}';
    
    // Pooling UI Settings
    if (poolToggle) poolToggle.checked = appConfig.enableAccountPooling;
    if (poolMode) poolMode.value = appConfig.poolingMode || 'even';
    if (poolChunk) poolChunk.value = appConfig.poolingChunkSize || 50;

    // FIX: Render Checkboxes for all saved instances (Moved INSIDE the load function)
    const poolContainer = document.getElementById('adminPoolInstancesContainer');
    if (poolContainer) {
        const instances = JSON.parse(localStorage.getItem('wa_instances') || '[]');
        poolContainer.innerHTML = instances.map(inst => `
            <div class="form-check">
                <input class="form-check-input pool-instance-cb" type="checkbox" value="${inst.id}" id="pool_${inst.id}" 
                    ${(appConfig.pooledInstances || []).includes(inst.id) ? 'checked' : ''}>
                <label class="form-check-label" for="pool_${inst.id}">
                    ${escapeHtml(inst.name)} <small class="text-muted">(${inst.id})</small>
                </label>
            </div>
        `).join('');
    }
}

function adminSaveSettings() {
    // Save delay settings
    const delayVal = parseInt(document.getElementById('adminDelayRange').value);
    appConfig.rateDelay = delayVal;

    // Save jitter toggle
    const jitterToggle = document.getElementById('adminJitterToggle');
    if (jitterToggle) {
        appConfig.randomizeDelay = jitterToggle.checked;
    }

    // Save file size
    const sizeSlider = document.getElementById('adminFileSizeRange');
    if (sizeSlider) {
        appConfig.maxFileSizeMB = parseInt(sizeSlider.value);
        appConfig.maxFileSizeBytes = appConfig.maxFileSizeMB * 1024 * 1024;
    }

    // Save master PC settings
    const masterToggle = document.getElementById('adminMasterToggle');
    const ipInput = document.getElementById('adminMasterIP');

    if (masterToggle && ipInput) {
        appConfig.isMasterPC = masterToggle.checked;
        appConfig.masterIP = ipInput.value.trim();
    }

    // Save enterprise settings
    const batchSize = document.getElementById('adminBatchSize');
    const batchDelay = document.getElementById('adminBatchDelay');
    const parallelLimit = document.getElementById('adminParallelLimit');
    const maxContacts = document.getElementById('adminMaxContacts');
    const safetyToggle = document.getElementById('adminSafetyToggle');
    const watermarkToggle = document.getElementById('adminWatermarkToggle');
    const watermarkFormat = document.getElementById('adminWatermarkFormat');
    const watermarkText = document.getElementById('adminWatermarkText');

    if (batchSize) appConfig.batchSize = parseInt(batchSize.value);
    if (batchDelay) appConfig.batchDelay = parseInt(batchDelay.value) * 1000;
    if (parallelLimit) appConfig.parallelLimit = parseInt(parallelLimit.value);
    if (maxContacts) appConfig.maxContactsPerBatch = parseInt(maxContacts.value);
    if (safetyToggle) appConfig.enableProgressiveDelay = safetyToggle.checked;
    if (watermarkToggle) appConfig.enableWatermarking = watermarkToggle.checked;
    if (watermarkFormat) appConfig.watermarkFormat = watermarkFormat.value;
    if (watermarkText) appConfig.watermarkText = watermarkText.value;

    // Save Pooling Settings
    const poolToggle = document.getElementById('adminPoolToggle');
    if (poolToggle) appConfig.enableAccountPooling = poolToggle.checked;

    const poolMode = document.getElementById('adminPoolMode');
    if (poolMode) appConfig.poolingMode = poolMode.value;

    const poolChunk = document.getElementById('adminPoolChunkSize');
    if (poolChunk) appConfig.poolingChunkSize = parseInt(poolChunk.value) || 50;

    // Save Selected Instances Array
    const selectedPoolCbs = document.querySelectorAll('.pool-instance-cb:checked');
    if (selectedPoolCbs.length > 0) {
        appConfig.pooledInstances = Array.from(selectedPoolCbs).map(cb => cb.value);
    } else {
        appConfig.pooledInstances = [];
    }

    // FIX: Call saveAppConfig() AFTER grabbing all the new pooling data
    saveAppConfig();
    showToast('All settings saved successfully', 'success');

    logActivity({
        type: 'system',
        message: 'Updated system settings',
        success: true
    });
}

function loadAdminInstances() {
    const container = document.getElementById('adminInstanceList');
    if (!container) return;

    container.innerHTML = '';

    let instances = JSON.parse(localStorage.getItem('wa_instances') || '[]');

    // Ensure at least one default instance exists
    if (instances.length === 0) {
        instances.push({
            id: DEFAULT_CONFIG.currentInstanceId,
            name: 'Default Instance',
            endpoint: DEFAULT_CONFIG.currentEndpoint,
            token: ''
        });
        localStorage.setItem('wa_instances', JSON.stringify(instances));
    }

    const activeId = getActiveInstance().id;

    instances.forEach(inst => {
        const isActive = inst.id === activeId;
        const activeClass = isActive ? 'list-group-item-primary' : '';
        const activeBadge = isActive ? '<span class="badge bg-primary ms-2">Active</span>' : '';

        const item = document.createElement('div');
        item.className = `list-group-item d-flex justify-content-between align-items-center ${activeClass}`;

        item.innerHTML = `
            <div>
                <strong>${escapeHtml(inst.name)}</strong> ${activeBadge}<br>
                <small class="text-muted">ID: ${escapeHtml(inst.id)}</small><br>
                <small class="text-muted truncate">${escapeHtml(inst.endpoint)}</small>
            </div>
            <div class="btn-group">
                ${!isActive ? `
                    <button class="btn btn-sm btn-outline-primary" onclick="adminSwitchInstance('${inst.id}')" title="Make Active">
                        Select
                    </button>
                ` : ''}
                <button class="btn btn-sm btn-outline-warning" onclick="adminEditInstance('${inst.id}')" title="Edit">
                    <i class="bi bi-pencil"></i>
                </button>
                <button class="btn btn-sm btn-outline-danger" onclick="adminDeleteInstance('${inst.id}')" title="Delete">
                    <i class="bi bi-trash"></i>
                </button>
            </div>
        `;
        container.appendChild(item);
    });
}

// NEW FUNCTION: Loads the instance into the form for editing
function adminEditInstance(id) {
    const instances = JSON.parse(localStorage.getItem('wa_instances') || '[]');
    const inst = instances.find(i => i.id === id);
    if (!inst) return;

    document.getElementById('adminNewName').value = inst.name;
    document.getElementById('adminNewId').value = inst.id;
    document.getElementById('adminNewEndpoint').value = inst.endpoint;
    document.getElementById('adminNewToken').value = inst.token || '';

    editingInstanceId = id; // Flag that we are editing

    // Change button appearance visually to show update mode
    const addBtn = document.getElementById('adminAddInstanceBtn');
    if (addBtn) {
        addBtn.innerHTML = '<i class="bi bi-check-circle"></i> Update Instance';
        addBtn.classList.remove('btn-primary', 'btn-dark'); // removing potential standard classes
        addBtn.classList.add('btn-warning');
    }

    document.getElementById('adminNewName').focus();
    showToast(`Editing ${inst.name}`, 'info');
}


// UPGRADED FUNCTION: Handles both Adding and Editing instances flawlessly
function adminAddInstance(e) {
    // Prevent accidental page reload if the button is inside a form
    if (e) e.preventDefault();
    if (window.event) window.event.preventDefault();

    const name = document.getElementById('adminNewName').value.trim();
    const id = document.getElementById('adminNewId').value.trim();
    const endpoint = document.getElementById('adminNewEndpoint').value.trim();
    const token = document.getElementById('adminNewToken').value.trim();

    if (!name || !id || !endpoint) {
        showToast('Name, Instance ID, and Endpoint are required.', 'error');
        return;
    }

    let instances = JSON.parse(localStorage.getItem('wa_instances') || '[]');

    if (editingInstanceId) {
        // --- UPDATE MODE ---
        if (id !== editingInstanceId && instances.some(i => i.id === id)) {
            showToast('Instance ID already exists.', 'error');
            return;
        }

        const index = instances.findIndex(i => i.id === editingInstanceId);
        if (index !== -1) {
            instances[index] = { name, id, endpoint, token };
        }

        // Critical Fix: If you are editing the ACTIVE instance, update the main app config!
        const activeId = localStorage.getItem('wa_active_instance_id') || appConfig.currentInstanceId;
        if (activeId === editingInstanceId) {
            localStorage.setItem('wa_active_instance_id', id);
            appConfig.currentInstanceId = id;
            appConfig.currentEndpoint = endpoint;
            appConfig.currentToken = token;
            saveAppConfig(); // Save to local storage
        }

        // Fix pooling array if the Instance ID was changed
        if (appConfig.pooledInstances) {
            const poolIndex = appConfig.pooledInstances.indexOf(editingInstanceId);
            if (poolIndex !== -1) {
                appConfig.pooledInstances[poolIndex] = id;
                saveAppConfig();
            }
        }

        showToast('Instance updated successfully.', 'success');
        
        // Log Update Activity
        logActivity({
            type: 'system',
            message: `Updated WhatsApp instance: ${name}`,
            success: true
        });

        // Reset button appearance back to "Add Instance"
        const addBtn = document.getElementById('adminAddInstanceBtn');
        if (addBtn) {
            addBtn.innerHTML = '<i class="bi bi-plus-circle"></i> Add Instance';
            addBtn.classList.remove('btn-warning');
            addBtn.classList.add('btn-primary');
        }
        
        editingInstanceId = null; // Clear edit flag

    } else {
        // --- ADD NEW MODE ---
        if (instances.some(i => i.id === id)) {
            showToast('Instance ID already exists.', 'error');
            return;
        }
        instances.push({ name, id, endpoint, token });
        showToast('Instance configuration added.', 'success');
        
        logActivity({
            type: 'system',
            message: `Added WhatsApp instance: ${name}`,
            success: true
        });
    }

    // Save the array to database
    localStorage.setItem('wa_instances', JSON.stringify(instances));

    // Clear form inputs
    document.getElementById('adminNewName').value = '';
    document.getElementById('adminNewId').value = '';
    document.getElementById('adminNewEndpoint').value = '';
    document.getElementById('adminNewToken').value = '';

    // FIX: Force everything on the screen to redraw instantly
    loadAdminInstances();
    loadAdminSettings(); 
    updateHeaderInstanceInfo(); // Updates the name in the top navigation bar!
}

function adminSwitchInstance(id) {
    localStorage.setItem('wa_active_instance_id', id);

    // Force appConfig to update immediately from the new selection
    const active = getActiveInstance();
    appConfig.currentInstanceId = active.id;
    appConfig.currentEndpoint = active.endpoint;
    appConfig.currentToken = active.token;
    
    // Save to permanent storage
    saveAppConfig();

    // UI Refresh
    loadAdminInstances();
    loadAdminSettings(); // Refresh checkboxes
    
    // THE CRITICAL FIX: Tell the header to restart its health check with the NEW ID
    updateHeaderInstanceInfo(); 
    
    showToast(`Switched to: ${active.name}`, 'success');

    logActivity({
        type: 'system',
        message: `Switched to WhatsApp instance: ${active.name}`,
        success: true
    });
}
function adminDeleteInstance(id) {
    if (!confirm('Are you sure you want to delete this instance configuration?')) return;

    let instances = JSON.parse(localStorage.getItem('wa_instances') || '[]');
    const instanceToDelete = instances.find(i => i.id === id);

    instances = instances.filter(i => i.id !== id);
    localStorage.setItem('wa_instances', JSON.stringify(instances));

    // UPGRADE: Remove from Account Pooling if it was checked
    if (appConfig.pooledInstances) {
        appConfig.pooledInstances = appConfig.pooledInstances.filter(poolId => poolId !== id);
        saveAppConfig();
    }

    // FIX: Reload both the list AND the pooling checkboxes instantly!
    loadAdminInstances();
    loadAdminSettings(); 
    showToast('Instance removed.', 'info');

    logActivity({
        type: 'system',
        message: `Deleted WhatsApp instance: ${instanceToDelete?.name || id}`,
        success: true
    });
}

async function adminDetectIP() {
    try {
        const ip = await getCurrentIP();
        document.getElementById('adminMasterIP').value = ip;
        showToast(`Detected IP: ${ip}`, 'info');
    } catch (error) {
        showToast('Failed to detect IP', 'error');
    }
}

async function adminCheckServer(eventOrSilent = false) {
    const isSilent = typeof eventOrSilent === 'boolean' ? eventOrSilent : false;
    const badge = document.getElementById('adminServerStatus');
    
    if (badge && !isSilent) {
        badge.className = 'badge bg-warning text-dark';
        badge.innerHTML = '<i class="bi bi-hourglass-split"></i> Checking...';
    }

    try {
        // We now ping the root "/" route we just added to Python
        const response = await fetch('http://localhost:5000/', {
            method: 'GET',
            mode: 'cors'
        });

        if (response.ok) {
            if (badge) {
                badge.className = 'badge bg-success';
                badge.innerHTML = '<i class="bi bi-check-circle"></i> Online';
            }
            // Only show toast if user clicked the button, not during auto-startup
            if (!isSilent) showToast('Watermark Server is Online', 'success');
        } else {
            throw new Error("Server response not OK");
        }
    } catch (e) {
        if (badge) {
            badge.className = 'badge bg-danger';
            badge.innerHTML = '<i class="bi bi-x-circle"></i> Offline';
        }
        if (!isSilent) showToast('Cannot reach Python Server (localhost:5000)', 'error');
        console.warn("Watermark Server Check Failed: Ensure server.py is running.");
    }
}

function adminSaveSettings() {
    // Save delay settings
    const delayVal = parseInt(document.getElementById('adminDelayRange').value);
    appConfig.rateDelay = delayVal;

    // Save jitter toggle
    const jitterToggle = document.getElementById('adminJitterToggle');
    if (jitterToggle) {
        appConfig.randomizeDelay = jitterToggle.checked;
    }

    // Save file size
    const sizeSlider = document.getElementById('adminFileSizeRange');
    if (sizeSlider) {
        appConfig.maxFileSizeMB = parseInt(sizeSlider.value);
        appConfig.maxFileSizeBytes = appConfig.maxFileSizeMB * 1024 * 1024;
    }

    // Save master PC settings
    const masterToggle = document.getElementById('adminMasterToggle');
    const ipInput = document.getElementById('adminMasterIP');

    if (masterToggle && ipInput) {
        appConfig.isMasterPC = masterToggle.checked;
        appConfig.masterIP = ipInput.value.trim();
    }

    // Save enterprise settings
    const batchSize = document.getElementById('adminBatchSize');
    const batchDelay = document.getElementById('adminBatchDelay');
    const parallelLimit = document.getElementById('adminParallelLimit');
    const maxContacts = document.getElementById('adminMaxContacts');
    const safetyToggle = document.getElementById('adminSafetyToggle');
    const watermarkToggle = document.getElementById('adminWatermarkToggle');
    const watermarkFormat = document.getElementById('adminWatermarkFormat');
    const watermarkText = document.getElementById('adminWatermarkText');

    if (batchSize) appConfig.batchSize = parseInt(batchSize.value);
    if (batchDelay) appConfig.batchDelay = parseInt(batchDelay.value) * 1000;
    if (parallelLimit) appConfig.parallelLimit = parseInt(parallelLimit.value);
    if (maxContacts) appConfig.maxContactsPerBatch = parseInt(maxContacts.value);
    if (safetyToggle) appConfig.enableProgressiveDelay = safetyToggle.checked;
    if (watermarkToggle) appConfig.enableWatermarking = watermarkToggle.checked;
    if (watermarkFormat) appConfig.watermarkFormat = watermarkFormat.value;
    if (watermarkText) appConfig.watermarkText = watermarkText.value;

    // Save Pooling Settings
    const poolToggle = document.getElementById('adminPoolToggle');
    if (poolToggle) appConfig.enableAccountPooling = poolToggle.checked;

    const poolMode = document.getElementById('adminPoolMode');
    if (poolMode) appConfig.poolingMode = poolMode.value;

    const poolChunk = document.getElementById('adminPoolChunkSize');
    if (poolChunk) appConfig.poolingChunkSize = parseInt(poolChunk.value) || 50;

    // Save Selected Instances Array
    const selectedPoolCbs = document.querySelectorAll('.pool-instance-cb:checked');
    if (selectedPoolCbs.length > 0) {
        appConfig.pooledInstances = Array.from(selectedPoolCbs).map(cb => cb.value);
    } else {
        appConfig.pooledInstances = [];
    }

    // Call saveAppConfig() AFTER grabbing all the new pooling data
    saveAppConfig();
    showToast('All settings saved successfully', 'success');

    logActivity({
        type: 'system',
        message: 'Updated system settings',
        success: true
    });
}

function adminFactoryReset() {
    const confirmation = prompt('Type "RESET" to confirm deletion of ALL data (Contacts, Logs, Settings).');
    if (confirmation === 'RESET') {
        localStorage.clear();
        showToast('All data cleared. Reloading...', 'warning');
        setTimeout(() => location.reload(), 2000);
    }
}

/* ========================================================================== */
/* 16. BACKUP & RESTORE                                                       */
/* ========================================================================== */

function downloadBackup() {
    const backupData = {
        meta: {
            date: new Date().toISOString(),
            version: '4.0',
            app: 'WhatsApp Sender Pro'
        },
        config: JSON.parse(localStorage.getItem('wa_app_config') || '{}'),
        contacts: JSON.parse(localStorage.getItem('wa_contacts') || '[]'),
        templates: JSON.parse(localStorage.getItem('wa_templates') || '[]'),
        instances: JSON.parse(localStorage.getItem('wa_instances') || '[]'),
        schedules: JSON.parse(localStorage.getItem('wa_schedules') || '[]'),
        logs: JSON.parse(localStorage.getItem('wa_logs') || '[]'),
        activities: JSON.parse(localStorage.getItem('wa_activities') || '[]'),
        notifications: JSON.parse(localStorage.getItem('wa_notification_settings') || '{}')
    };

    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(backupData, null, 2));
    const downloadAnchorNode = document.createElement('a');

    const fileName = `whatsapp_backup_${new Date().toISOString().slice(0, 10)}.json`;

    downloadAnchorNode.setAttribute("href", dataStr);
    downloadAnchorNode.setAttribute("download", fileName);
    document.body.appendChild(downloadAnchorNode);
    downloadAnchorNode.click();
    downloadAnchorNode.remove();

    showToast('Backup downloaded successfully', 'success');

    logActivity({
        type: 'system',
        message: 'Downloaded system backup',
        success: true
    });
}

function restoreBackup(e) {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function (ev) {
        try {
            const data = JSON.parse(ev.target.result);

            // Basic validation
            if (!data.meta || !data.meta.app || data.meta.app !== 'WhatsApp Sender Pro') {
                throw new Error("Invalid backup file");
            }

            if (confirm('Restoring will OVERWRITE current data. Continue?')) {
                if (data.config) localStorage.setItem('wa_app_config', JSON.stringify(data.config));
                if (data.contacts) localStorage.setItem('wa_contacts', JSON.stringify(data.contacts));
                if (data.templates) localStorage.setItem('wa_templates', JSON.stringify(data.templates));
                if (data.instances) localStorage.setItem('wa_instances', JSON.stringify(data.instances));
                if (data.schedules) localStorage.setItem('wa_schedules', JSON.stringify(data.schedules));
                if (data.logs) localStorage.setItem('wa_logs', JSON.stringify(data.logs));
                if (data.activities) localStorage.setItem('wa_activities', JSON.stringify(data.activities));
                if (data.notifications) localStorage.setItem('wa_notification_settings', JSON.stringify(data.notifications));

                showToast('Restoration Complete! The page will reload.', 'success');

                logActivity({
                    type: 'system',
                    message: 'Restored system from backup',
                    success: true
                });

                setTimeout(() => location.reload(), 1500);
            }
        } catch (err) {
            console.error(err);
            showToast('Invalid Backup File Format', 'error');
        }
    };
    reader.readAsText(file);
}

/* ========================================================================== */
/* 17. NOTIFICATION AUTOMATION                                                */
/* ========================================================================== */

function loadNotificationSettings() {
    const savedSettings = localStorage.getItem('wa_notification_settings');
    const settings = savedSettings ? JSON.parse(savedSettings) : {};

    const startEl = document.getElementById('notifStartMsg');
    const renewalEl = document.getElementById('notifRenewalMsg');
    const endEl = document.getElementById('notifEndMsg');

    if (startEl) startEl.value = settings.startMsg || '';
    if (renewalEl) renewalEl.value = settings.renewalMsg || '';
    if (endEl) endEl.value = settings.endMsg || '';
}

function saveNotificationSettings() {
    const startMsg = document.getElementById('notifStartMsg').value.trim();
    const renewalMsg = document.getElementById('notifRenewalMsg').value.trim();
    const endMsg = document.getElementById('notifEndMsg').value.trim();

    const settings = {
        startMsg: startMsg,
        renewalMsg: renewalMsg,
        endMsg: endMsg
    };

    localStorage.setItem('wa_notification_settings', JSON.stringify(settings));
    showToast('Automation Notification Settings Saved Successfully', 'success');

    logActivity({
        type: 'system',
        message: 'Updated notification automation settings',
        success: true
    });
}

/* ========================================================================== */
/* 18. UTILITY FUNCTIONS                                                      */
/* ========================================================================== */

/**
 * Check if a contact's plan is being renewed (dates changed)
 * REMOVED: 7-day criteria
 */
function isPlanRenewed(oldContact, newContact) {
    const oldEnd = oldContact.endDate || "";
    const newEnd = newContact.endDate || "";
    const oldStart = oldContact.startDate || "";
    const newStart = newContact.startDate || "";

    // If no dates in new contact, not a renewal
    if (!newEnd && !newStart) return false;

    // Check if any date is being changed
    const startDateChanged = (oldStart !== newStart) && newStart;
    const endDateChanged = (oldEnd !== newEnd) && newEnd;

    // If either start or end date is changed, it's a renewal
    return startDateChanged || endDateChanged;
}

function getLocalDateString() {
    const d = new Date();
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function getRoutedInstance(currentIndex, totalContacts) {
    const allInstances = JSON.parse(localStorage.getItem('wa_instances') || '[]');
    const activeDefault = getActiveInstance();

    // If pooling is off or no extra instances selected, use the default active number
    if (!appConfig.enableAccountPooling || !appConfig.pooledInstances || appConfig.pooledInstances.length === 0) {
        return activeDefault;
    }

    // Get the actual instance objects based on selected IDs
    const pool = appConfig.pooledInstances
        .map(id => allInstances.find(inst => inst.id === id))
        .filter(Boolean);

    if (pool.length === 0) return activeDefault;
    if (pool.length === 1) return pool[0]; // Only one selected

    let poolIndex = 0;

    if (appConfig.poolingMode === 'even') {
        // Mode 1: Split Evenly (e.g., 5000 contacts / 5 numbers = 1000 per number sequentially)
        const chunkSize = Math.ceil(totalContacts / pool.length);
        poolIndex = Math.floor(currentIndex / chunkSize);
    } else {
        // Mode 2: Rotate (e.g., Number A sends 50, Number B sends 50, Number C sends 50...)
        poolIndex = Math.floor(currentIndex / appConfig.poolingChunkSize) % pool.length;
    }

    // Return the calculated instance (with fallback safety)
    return pool[poolIndex] || activeDefault;
}

// UPDATED: Now accepts a specific instance parameter
function buildPayload(to, msg, b64, fname, specificInstance = null) {
    const inst = specificInstance || getActiveInstance();
    return {
        to: to,
        body: msg || ' ',
        filename: fname || '',
        base64: b64 || '',
        instance_id: inst.id,
        token: inst.token
    };
}

async function postSendAndHandleResponse(payload, fname, msg, to, resDiv, specificInstance = null) {
    // UPGRADE: Use specific instance if provided, otherwise default to active instance
    const inst = specificInstance || getActiveInstance();

    if (resDiv && resDiv.id === 'singleResult') {
        const progressEl = document.getElementById('singleProgress');
        if (progressEl) {
            progressEl.innerHTML = `<i class="bi bi-cloud-upload"></i> Sending to server (${inst.name})...`;
        }
    }

    try {
        const resp = await fetch(inst.endpoint || 'send.php', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        const json = await resp.json();

        let ok = false;
        let apiId = '';

        if (json.results && Array.isArray(json.results) && json.results.length > 0) {
            ok = json.results[0].success;
            apiId = json.results[0].id || '';
        } else if (json.success) {
            ok = true;
        } else if (resp.ok && !json.error) {
            ok = true;
        }

        if (resDiv && resDiv.id === 'singleResult') {
            const cls = ok ? 'alert-success' : 'alert-danger';
            const icon = ok ? 'check-circle' : 'x-circle';
            const txt = ok ? `Sent Successfully. ID: ${apiId}` : `Failed. Response: ${JSON.stringify(json)}`;
            resDiv.innerHTML = `<div class="alert ${cls}"><i class="bi bi-${icon}"></i> ${txt}</div>`;
        }

        // UPDATE THIS BLOCK INSIDE postSendAndHandleResponse (Success/API Fail Block)
        let failReason = '';
        if (!ok) {
            // Try to extract a clean error message from the API response
            failReason = json.error || json.message || json.details || JSON.stringify(json);
            if (typeof failReason === 'string' && (failReason.includes("payment") || failReason.includes("Stopped"))) {
                const statusBadge = document.getElementById('apiLiveStatus');
                if (statusBadge) {
                    statusBadge.className = 'badge bg-danger ms-2';
                    statusBadge.innerHTML = '<i class="bi bi-credit-card"></i> API Stopped (Unpaid)';
                }
                showToast(`API Warning: Instance is unpaid or stopped!`, 'error');
            }
        }

        pushLog({
            to: to,
            filename: fname,
            message: msg,
            status: ok ? 'sent' : 'failed',
            response: json,
            failedReason: failReason, // <-- NEW: Explicitly save the reason
            instanceUsed: inst.name // <-- UPGRADE: Track which number sent this
        });

        return ok;

    } catch (e) {
        console.error("Network/API Error:", e);
        if (resDiv && resDiv.id === 'singleResult') {
            resDiv.innerHTML = `<div class="alert alert-danger"><i class="bi bi-exclamation-triangle"></i> Network Error: ${e.message}</div>`;
        }

        // UPDATE THIS BLOCK (Network Catch Block)
        pushLog({
            to: to,
            filename: fname,
            message: msg,
            status: 'error',
            error: e.message,
            failedReason: e.message, // <-- NEW: Explicitly save the reason
            instanceUsed: inst.name // <-- UPGRADE: Track which number failed
        });

        return false;
    }
}

function fileToBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const result = reader.result;
            const base64 = result.split(',')[1] || result;
            resolve(base64);
        };
        reader.onerror = error => reject(error);
        reader.readAsDataURL(file);
    });
}
/**
 * Get watermarked base64 file with name + phone number
 */
async function getWatermarkedBase64(base64, fileType, watermarkText, alignment = 'diagonal') {
    if (!appConfig.enableWatermarking) return base64;

    if (fileType !== 'application/pdf' && !fileType.startsWith('image/')) {
        return base64;
    }

    const API_ENDPOINT = 'http://localhost:5000/api/watermark_file';

    try {
        console.log(`[Watermark] Requesting watermark for: ${watermarkText}`);
        console.log(`[Watermark] File type: ${fileType}`);

        const resp = await fetch(API_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                document_base64: base64,
                file_type: fileType,
                watermark_text: watermarkText,
                alignment: alignment || 'diagonal',
                font_size: 40,
                opacity: 0.3
            })
        });

        if (!resp.ok) {
            throw new Error(`Watermark Server Error: ${resp.status} - ${await resp.text()}`);
        }

        const data = await resp.json();

        if (!data.watermarked_base64) {
            throw new Error('Watermark Server returned empty data');
        }

        console.log(`[Watermark] Successfully watermarked: ${watermarkText}`);
        return data.watermarked_base64;

    } catch (error) {
        console.error("Watermark Generation Failed:", error);
        console.log("[Watermark] Falling back to original file");
        return base64;
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function escapeHtml(text) {
    return String(text || '').replace(/[&<>"']/g, m => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    })[m]);
}

function injectToastStyles() {
    const existing = document.getElementById('custom-toast-style');
    if (existing) return;

    const s = document.createElement('style');
    s.id = 'custom-toast-style';
    s.innerHTML = `
        #toast-container {
            position: fixed;
            top: 20px;
            right: 20px;
            z-index: 10000;
            display: flex;
            flex-direction: column;
            gap: 10px;
        }
        .custom-toast {
            min-width: 300px;
            padding: 15px 20px;
            border-radius: 8px;
            color: white;
            opacity: 0;
            animation: fadeIn 0.4s forwards;
            box-shadow: 0 5px 15px rgba(0,0,0,0.2);
            font-family: system-ui, -apple-system, sans-serif;
            font-size: 14px;
            display: flex;
            align-items: center;
        }
        .toast-success { background-color: #198754; border-left: 5px solid #0f5132; }
        .toast-warning { background-color: #ffc107; color: #000; border-left: 5px solid #d39e00; }
        .toast-error { background-color: #dc3545; border-left: 5px solid #842029; }
        .toast-info { background-color: #0dcaf0; color: #000; border-left: 5px solid #0aa2c0; }
        
        @keyframes fadeIn {
            from { opacity: 0; transform: translateX(20px); }
            to { opacity: 1; transform: translateX(0); }
        }
        @keyframes fadeOut {
            from { opacity: 1; transform: translateX(0); }
            to { opacity: 0; transform: translateX(20px); }
        }
    `;
    document.head.appendChild(s);

    const c = document.createElement('div');
    c.id = 'toast-container';
    document.body.appendChild(c);
}

function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `custom-toast toast-${type}`;
    toast.innerHTML = `
        <i class="bi ${type === 'success' ? 'bi-check-circle' :
            type === 'warning' ? 'bi-exclamation-triangle' :
                type === 'error' ? 'bi-x-circle' : 'bi-info-circle'} me-2"></i>
        ${message}
    `;

    container.appendChild(toast);

    setTimeout(() => {
        toast.style.animation = 'fadeOut 0.5s forwards';
        toast.addEventListener('animationend', () => toast.remove());
    }, 3500);
}
/**
 * Real-time filter for contact lists
 */
function applyRealTimeFilter(inputId, listId) {
    const input = document.getElementById(inputId);
    const listContainer = document.getElementById(listId);

    if (!input || !listContainer) return;

    const term = input.value.toLowerCase().trim();
    // Get all direct child divs (the contact items)
    const items = listContainer.querySelectorAll(':scope > div');

    items.forEach(item => {
        // Skip the "No contacts saved" message if it exists
        if (item.classList.contains('text-muted') && item.textContent.includes('No contacts')) {
            return;
        }

        const text = item.textContent.toLowerCase();
        item.style.display = text.includes(term) ? '' : 'none';
    });
}

/**
 * Generates the current date in DD-TamilMonth-YYYY (Gregorian style)
 */
function getTamilDate() {
    const gregorianMonthsTamil = [
        "ஜனவரி", "பிப்ரவரி", "மார்ச்", "ஏப்ரல்", "மே", "ஜூன்", 
        "ஜூலை", "ஆகஸ்ட்", "செப்டம்பர்", "அக்டோபர்", "நவம்பர்", "டிசம்பர்"
    ];

    const d = new Date();
    const day = String(d.getDate()).padStart(2, '0');
    const month = gregorianMonthsTamil[d.getMonth()]; 
    const year = d.getFullYear();

    return `${day}-${month}-${year}`; // Result: 08-மார்ச்-2026
}

/**
 * Enterprise Variable Parser: {name}, {date}, and {filename}
 */
function parseMessageVariables(msg, name, filename = "") {
    if (!msg) return " ";
    
    const tamilDate = getTamilDate();
    
    // FILENAME LOGIC: 
    // If filename is "Invoice_123.pdf", this regex makes it "Invoice_123"
    // If no file is attached, it defaults to "கோப்பு" (Document)
    const cleanFilename = filename 
        ? filename.replace(/\.[^/.]+$/, "") 
        : "கோப்பு";

    return msg
        .replace(/{name}/g, name || "வாடிக்கையாளர்")
        .replace(/{date}/g, tamilDate)
        .replace(/{filename}/g, cleanFilename);
}

/**
 * Converts a YYYY-MM-DD string into DD-TamilMonth-YYYY
 */
function formatTamilDateFromStr(dateStr) {
    const gregorianMonthsTamil = [
        "ஜனவரி", "பிப்ரவரி", "மார்ச்", "ஏப்ரல்", "மே", "ஜூன்", 
        "ஜூலை", "ஆகஸ்ட்", "செப்டம்பர்", "அக்டோபர்", "நவம்பர்", "டிசம்பர்"
    ];

    const d = new Date(dateStr);
    const day = String(d.getDate()).padStart(2, '0');
    const month = gregorianMonthsTamil[d.getMonth()]; 
    const year = d.getFullYear();

    return `${day}-${month}-${year}`;
}

/* ========================================================================== */
/* 19. CSV IMPORT HANDLERS                                                    */
/* ========================================================================== */

function handleContactCsvImport(e) {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = () => {
        const content = reader.result;
        const lines = content.split(/\r?\n/).map(s => s.trim()).filter(Boolean);

        let list = JSON.parse(localStorage.getItem('wa_contacts') || '[]');
        let addedCount = 0;

        lines.forEach((line) => {
            const parts = line.split(',').map(p => p.trim());
            let name, phone, startDate, endDate;

            if (parts.length >= 2) {
                name = parts[0];
                phone = parts[1].replace(/[^0-9+]/g, '');
                startDate = parts[2] || '';
                endDate = parts[3] || '';
            } else if (parts.length === 1) {
                phone = parts[0].replace(/[^0-9+]/g, '');
                name = phone;
            } else {
                return;
            }

            if (phone) {
                if (!list.some(existingC => existingC.phone === phone)) {
                    list.push({
                        name: name || phone,
                        phone: phone,
                        startDate: startDate,
                        endDate: endDate,
                        notifiedEnd: false,
                        importedAt: new Date().toISOString()
                    });
                    addedCount++;
                }
            }
        });

        if (addedCount > 0) {
            localStorage.setItem('wa_contacts', JSON.stringify(list));
            loadContacts();
            showToast(`Successfully imported ${addedCount} new contacts.`, 'success');

            logActivity({
                type: 'contact',
                message: `Imported ${addedCount} contacts from CSV`,
                success: true
            });
        } else {
            showToast('No new valid contacts found in CSV.', 'warning');
        }

        e.target.value = '';
    };
    reader.readAsText(file);
}

/* ========================================================================== */
/* 20. DEBUG & TEST FUNCTIONS                                                 */
/* ========================================================================== */

/**
 * Test function for auto-responder
 */
function testAutoResponder() {
    console.log("🧪 Manually triggering auto-responder...");
    console.log("📅 Today's date:", getLocalDateString());

    const contacts = JSON.parse(localStorage.getItem('wa_contacts') || '[]');
    console.log("👥 Total contacts:", contacts.length);

    contacts.forEach((contact, i) => {
        console.log(`${i + 1}. ${contact.name} (${contact.phone}):`, {
            start: contact.startDate,
            end: contact.endDate,
            startNotified: contact.startNotified,
            notifiedEnd: contact.notifiedEnd,
            renewalNotified: contact.renewalNotified
        });
    });

    // Trigger the auto-responder
    checkAndSendAutomatedMessages();
}

/**
 * Force send renewal for a specific contact (debug tool)
 */
function forceRenewal(phoneNumber) {
    const contacts = JSON.parse(localStorage.getItem('wa_contacts') || '[]');
    const contact = contacts.find(c => c.phone === phoneNumber);

    if (!contact) {
        console.error("Contact not found:", phoneNumber);
        return;
    }

    console.log("🚀 Forcing renewal for:", contact.name);
    triggerAutomatedNotification('renewal', contact);
}

/**
 * Test watermark functionality
 */
function testWatermark() {
    console.log("🎨 Testing Watermark Settings:");
    console.log("- Enabled:", appConfig.enableWatermarking);
    console.log("- Format:", appConfig.watermarkFormat);
    console.log("- Custom Text:", appConfig.watermarkText);
    console.log("- Example: John Doe - +1234567890 =", generateWatermarkText("John Doe", "+1234567890"));
}

/* ========================================================================== */
/* 21. INITIALIZATION COMPLETE                                                */
/* ========================================================================== */

console.log('WhatsApp Sender Pro v4.0 - Fully Fixed Enterprise Edition Initialized');