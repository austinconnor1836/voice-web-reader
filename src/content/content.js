(() => {
    let readingState = {
        isReading: false,
        isPaused: false,
        sentences: [], // Array of { text: string, elements: HTMLElement[] }
        currentIndex: 0,
        utterance: null,
        settings: {
            rate: 1.0,
            voiceURI: null
        }
    };

    // Listen for messages from popup
    chrome.runtime.onMessage.addListener((request, sender, senderResponse) => {
        if (request.action === 'play') {
            if (request.settings) {
                readingState.settings = request.settings;
            }
            startReading();
        } else if (request.action === 'pause') {
            pauseReading();
        } else if (request.action === 'stop') {
            stopReading();
        } else if (request.action === 'updateSettings') {
            if (request.settings) {
                const oldSettings = readingState.settings;
                readingState.settings = request.settings;

                // Only restart if Voice or Rate changed.
                if (readingState.isReading && !readingState.isPaused) {
                    if (oldSettings.voiceURI !== request.settings.voiceURI || oldSettings.rate !== request.settings.rate) {
                        // Prevent onend/onerror from firing and skipping to next sentence
                        if (readingState.utterance) {
                            readingState.utterance.onend = null;
                            readingState.utterance.onerror = null;
                        }
                        window.speechSynthesis.cancel();
                        speakNextSentence();
                    }
                }
            }
        }
        senderResponse({ status: 'ok' });
    });

    function cleanText(text) {
        return text.replace(/\s+/g, ' ').trim();
    }

    function getReadableNodes() {
        const selector = 'p, h1, h2, h3, h4, h5, h6, li, blockquote, div, article, section, main';
        const nodes = Array.from(document.querySelectorAll(selector));

        return nodes.filter(node => {
            const style = window.getComputedStyle(node);
            return style.display !== 'none'
                && style.visibility !== 'hidden'
                && node.innerText.trim().length > 0
                && !node.closest('nav, footer, script, style, noscript');
        });
    }

    function processContent() {
        if (readingState.sentences.length > 0) return;

        const nodes = getReadableNodes();
        const segmenter = new Intl.Segmenter(navigator.language, { granularity: 'sentence' });

        // Reverse to process deepest children first (bottom-up)
        // This prevents container divs from swallowing up semantic children like <p> tags
        nodes.reverse().forEach(node => {
            if (node.classList.contains('lexi-processed')) return;
            // Check if node has direct text or is a leaf-like block to avoid double processing
            // A simple heuristic: if it has significant direct text content, process it.
            // Or if it's a P/Heading/Li.
            // For DIVs, we only process if they don't contain other readable block elements we've already selected?
            // To be safe and simple: just check if it was already processed (via class).
            // But we need to be careful about nesting.
            // Better strategy: Process from bottom up? 
            // Current strategy: We iterate `nodes` which is querySelectorAll.
            // We'll skip if any ancestor has already been processed? 
            // Or just check if `node` contains raw text that hasn't been wrapped.

            // Let's rely on the tokenizer. We will build text from *all* text nodes in this block
            // that are NOT already inside a .lexi-sentence span.

            processNode(node, segmenter);
        });
    }

    function processNode(node, segmenter) {
        // Gather all valid text nodes in this block
        const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
        const textNodes = [];
        const ignoredTags = ['SUP', 'SCRIPT', 'STYLE', 'NOSCRIPT'];

        while (walker.nextNode()) {
            const currentNode = walker.currentNode;
            const parent = currentNode.parentNode;

            // Skip if already processed (e.g. inside a child <p> we already handled)
            if (parent.classList.contains('lexi-sentence')) continue;

            // Skip ignored tags (Superscripts, etc)
            if (ignoredTags.includes(parent.tagName)) continue;
            // Also skip if ancestor is ignored? (Usually sufficient to check parent for these specific inline tags)
            if (parent.closest('sup')) continue;

            textNodes.push(currentNode);
        }

        if (textNodes.length === 0) return;

        // PRE-PROCESSING: Normalize whitespace in DOM nodes
        // This ensures the segmenter sees clean text and prevents newlines/tabs from acting as splitters
        textNodes.forEach(tNode => {
            // Replace newlines and multiple spaces with a single space
            // We modify the DOM node directly so our offsets stay valid for the new content
            const oldText = tNode.textContent;
            const newText = oldText.replace(/\s+/g, ' ');

            // Only update if changed to avoid layout thrashing irrelevant nodes
            if (oldText !== newText) {
                tNode.textContent = newText;
            }
        });

        // Concatenate text to form the full "sentence-able" string
        // We map ranges of the full string back to (Node, StartIndex, EndIndex)
        let fullText = "";
        const nodeMap = []; // { node: TextNode, start: int, end: int }

        textNodes.forEach(tNode => {
            const start = fullText.length;
            fullText += tNode.textContent;
            const end = fullText.length;
            nodeMap.push({ node: tNode, start, end });
        });

        if (cleanText(fullText).length === 0) return;

        const segments = Array.from(segmenter.segment(fullText));

        // Mark node as processed so we don't do it again
        node.classList.add('lexi-processed');

        // Let's execute the NEW PLAN (Group by Text Node)
        // Map: TextNode -> [ { start, end, sentenceId } ]
        const nodeInstructions = new Map(); // Key: TextNode, Value: Array of pieces

        // Create sentence objects first
        const sentenceObjects = segments.map((seg, index) => {
            // Filter empty ones
            if (cleanText(seg.segment).length === 0) return null;
            return {
                id: Symbol('sentence_' + index),
                text: cleanText(seg.segment),
                elements: []
            };
        }).filter(s => s !== null);

        // Correct loop:
        let currentSenIdx = 0;
        segments.forEach(segment => {
            if (cleanText(segment.segment).length === 0) {
                // It's whitespace. We still need to preserve it in the DOM, 
                // but we don't assign it to a sentence for reading.
                // We can assign it to a "null" sentence or just text.
                const segStart = segment.index;
                const segEnd = segStart + segment.segment.length;
                distributeToNodes(segStart, segEnd, null, nodeMap, nodeInstructions);
                return;
            }

            const sentenceObj = sentenceObjects[currentSenIdx];
            currentSenIdx++;

            const segStart = segment.index;
            const segEnd = segStart + segment.segment.length;
            distributeToNodes(segStart, segEnd, sentenceObj, nodeMap, nodeInstructions);
        });

        // Execute replacements
        nodeInstructions.forEach((parts, textNode) => {
            const fragment = document.createDocumentFragment();
            parts.sort((a, b) => a.localStart - b.localStart);

            parts.forEach(part => {
                const textContent = textNode.textContent.substring(part.localStart, part.localEnd);
                if (part.sentenceObj) {
                    const span = document.createElement('span');
                    span.textContent = textContent;
                    span.className = 'lexi-sentence';
                    part.sentenceObj.elements.push(span);
                    fragment.appendChild(span);
                } else {
                    // Whitespace / non-sentence text
                    fragment.appendChild(document.createTextNode(textContent));
                }
            });

            textNode.parentNode.replaceChild(fragment, textNode);
        });

        // Add to global state
        readingState.sentences.push(...sentenceObjects);
    }

    function distributeToNodes(segStart, segEnd, sentenceObj, nodeMap, nodeInstructions) {
        nodeMap.forEach(mapItem => {
            const overlapStart = Math.max(segStart, mapItem.start);
            const overlapEnd = Math.min(segEnd, mapItem.end);

            if (overlapStart < overlapEnd) {
                const localStart = overlapStart - mapItem.start;
                const localEnd = overlapEnd - mapItem.start;

                if (!nodeInstructions.has(mapItem.node)) {
                    nodeInstructions.set(mapItem.node, []);
                }
                nodeInstructions.get(mapItem.node).push({
                    localStart,
                    localEnd,
                    sentenceObj
                });
            }
        });
    }

    function startReading() {
        processContent();

        if (readingState.isPaused) {
            window.speechSynthesis.resume();
            readingState.isPaused = false;
            readingState.isReading = true;
            return;
        }

        if (readingState.isReading) return;

        // Check for user selection to set start index
        const selection = window.getSelection();
        if (selection.rangeCount > 0 && !selection.isCollapsed) {
            const range = selection.getRangeAt(0);
            let startNode = range.startContainer;
            if (startNode.nodeType === Node.TEXT_NODE) startNode = startNode.parentNode;

            // Find sentence that contains this node
            const index = readingState.sentences.findIndex(s => s.elements.some(el => el === startNode || el.contains(startNode)));
            if (index !== -1) {
                readingState.currentIndex = index;
                selection.removeAllRanges();
            }
        }

        readingState.isReading = true;
        readingState.isPaused = false;
        speakNextSentence();
    }

    function speakNextSentence() {
        if (!readingState.isReading || readingState.sentences.length === 0) return;
        if (readingState.currentIndex >= readingState.sentences.length) {
            stopReading();
            return;
        }

        const item = readingState.sentences[readingState.currentIndex];

        // Scroll
        if (item.elements.length > 0) {
            item.elements[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
        }

        // Highlight
        document.querySelectorAll('.lexi-highlight').forEach(el => el.classList.remove('lexi-highlight'));
        item.elements.forEach(el => el.classList.add('lexi-highlight'));

        // Speak
        const utterance = new SpeechSynthesisUtterance(item.text);
        utterance.rate = readingState.settings.rate || 1.0;

        if (readingState.settings.voiceURI) {
            // Try getting voices again (paranoia)
            if (availableVoices.length === 0) loadVoices();
            // Even if we have some, try fresh if not found?
            let voice = availableVoices.find(v => v.voiceURI === readingState.settings.voiceURI);

            // Should usually find it. If not, try refreshing one last time.
            if (!voice) {
                loadVoices();
                voice = availableVoices.find(v => v.voiceURI === readingState.settings.voiceURI);
            }

            if (voice) utterance.voice = voice;
        }

        utterance.onend = () => {
            if (readingState.isReading && !readingState.isPaused) {
                item.elements.forEach(el => el.classList.remove('lexi-highlight'));
                readingState.currentIndex++;
                speakNextSentence();
            }
        };

        utterance.onerror = (e) => {
            console.error(e);
            readingState.currentIndex++;
            speakNextSentence();
        };

        readingState.utterance = utterance;
        window.speechSynthesis.speak(utterance);
    }

    function pauseReading() {
        if (readingState.isReading) {
            window.speechSynthesis.pause();
            readingState.isPaused = true;
        }
    }

    function stopReading() {
        if (readingState.utterance) {
            readingState.utterance.onend = null;
            readingState.utterance.onerror = null;
        }
        window.speechSynthesis.cancel();
        readingState.isReading = false;
        readingState.isPaused = false;
        readingState.currentIndex = 0;
        document.querySelectorAll('.lexi-highlight').forEach(el => el.classList.remove('lexi-highlight'));
    }

    // Fix: Stop reading when the page is closed/refreshed
    window.addEventListener('beforeunload', stopReading);

    // Fix: Ensure voices are available (Chrome requires this primarily)
    // Fix: Ensure voices are available (Chrome requires this primarily)
    let availableVoices = [];
    function loadVoices() {
        const voices = window.speechSynthesis.getVoices();
        if (voices.length > 0) {
            availableVoices = voices;
        }
    }

    // Initialize voices
    loadVoices();
    if (window.speechSynthesis.onvoiceschanged !== undefined) {
        window.speechSynthesis.addEventListener('voiceschanged', loadVoices);
    }

    function startReading() {
        // Fix: Capture selection BEFORE processing content if content hasn't been processed
        // But since we are removing the timeout, content *should* be processed.
        // However, dynamic pages might still be an issue.
        // Robust Strategy: 
        // 1. If selection exists, identify the text.
        // 2. Process content.
        // 3. Find sentence matching text/node.

        // Capture precall selection
        let selectedNode = null;
        const selection = window.getSelection();
        if (selection.rangeCount > 0 && !selection.isCollapsed) {
            const range = selection.getRangeAt(0);
            selectedNode = range.startContainer;
            if (selectedNode.nodeType === Node.TEXT_NODE) selectedNode = selectedNode.parentNode;
        }

        processContent();

        if (readingState.isPaused) {
            window.speechSynthesis.resume();
            readingState.isPaused = false;
            readingState.isReading = true;
            return;
        }

        if (readingState.isReading) return;

        // Try to match selection to a sentence
        if (selectedNode) {
            // Because processContent might have replaced the node, we need to check if selectedNode
            // is still in DOM or if established links exist.
            // If processContent ran *before* selection, selectedNode is likely one of our spans.
            // If processContent ran *after* (unlikely now we removed timeout), selectedNode is detached.

            // Best effort: Check if selectedNode is a lexi-sentence
            const index = readingState.sentences.findIndex(s =>
                s.elements.some(el => el === selectedNode || el.contains(selectedNode) || selectedNode.contains(el))
            );

            if (index !== -1) {
                readingState.currentIndex = index;
                selection.removeAllRanges();
            }
        }

        readingState.isReading = true;
        readingState.isPaused = false;
        speakNextSentence();
    }

    // ... (rest of functions) ...

    // Fix: Run immediately on load to ensure DOM is ready for selection
    // Removing the 1000ms delay to prevent race conditions where user selects text before processing
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', processContent);
    } else {
        processContent();
    }

    // Optional: Watch for dynamic content changes? 
    // integrating a simple mutation observer for stability could help, but kept simple for now.

})();
