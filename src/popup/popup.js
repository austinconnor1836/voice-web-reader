document.addEventListener('DOMContentLoaded', () => {
    const playPauseBtn = document.getElementById('playPauseBtn');
    const stopBtn = document.getElementById('stopBtn');
    const voiceSelect = document.getElementById('voiceSelect');
    const rateRange = document.getElementById('rateRange');
    const rateValue = document.getElementById('rateValue');

    let isPlaying = false;

    // Load saved settings
    chrome.storage.sync.get(['rate', 'voiceURI'], (data) => {
        if (data.rate) {
            rateRange.value = data.rate;
            rateValue.textContent = data.rate;
        }
        // Voice restoring happens after voices load
    });

    // Populate voices
    function populateVoices() {
        const voices = speechSynthesis.getVoices();
        voiceSelect.innerHTML = '';

        voices.forEach(voice => {
            const option = document.createElement('option');
            option.value = voice.voiceURI;
            option.textContent = `${voice.name} (${voice.lang})`;
            voiceSelect.appendChild(option);
        });

        chrome.storage.sync.get(['voiceURI'], (data) => {
            if (data.voiceURI) {
                voiceSelect.value = data.voiceURI;
            }
        });
    }

    populateVoices();
    if (speechSynthesis.onvoiceschanged !== undefined) {
        speechSynthesis.onvoiceschanged = populateVoices;
    }

    // Event Listeners
    playPauseBtn.addEventListener('click', () => {
        sendMessageToContent({
            action: isPlaying ? 'pause' : 'play',
            settings: getSettings()
        });
        isPlaying = !isPlaying;
        updatePlayButton();
    });

    stopBtn.addEventListener('click', () => {
        sendMessageToContent({ action: 'stop' });
        isPlaying = false;
        updatePlayButton();
    });

    rateRange.addEventListener('input', (e) => {
        rateValue.textContent = e.target.value;
        saveSettings();
        // Send live update
        sendMessageToContent({
            action: 'updateSettings',
            settings: getSettings()
        });
    });

    voiceSelect.addEventListener('change', () => {
        saveSettings();
        // Send live update
        sendMessageToContent({
            action: 'updateSettings',
            settings: getSettings()
        });
    });

    // Helper functions
    function getSettings() {
        return {
            voiceURI: voiceSelect.value,
            rate: parseFloat(rateRange.value)
        };
    }

    function saveSettings() {
        const settings = getSettings();
        chrome.storage.sync.set(settings);
    }

    function updatePlayButton() {
        playPauseBtn.innerHTML = isPlaying ? '<span class="icon">⏸</span> Pause' : '<span class="icon">▶</span> Play';
    }

    function sendMessageToContent(message) {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (tabs[0]) {
                chrome.tabs.sendMessage(tabs[0].id, message, (response) => {
                    if (chrome.runtime.lastError) {
                        console.error("Connection error:", chrome.runtime.lastError.message);
                        // Fallback: visual indication that script is missing
                        const status = document.getElementById('statusIndicator');
                        status.textContent = 'Please refresh the page!';
                        status.style.color = 'red';
                        status.style.fontSize = '12px';
                    }
                });
            }
        });
    }
});
