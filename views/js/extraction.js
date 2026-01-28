'use strict';

/**
 * Timetable Extraction Module
 * Shared module for OCR-based timetable extraction functionality
 * Used by both /timetables and /trains/:id pages
 */

window.ExtractionModule = (function() {
    // State
    let selectedImageFiles = [];
    let extractedEntries = [];
    let allRoutes = [];
    let extractRouteTrains = [];
    let extractSelectedTrains = [];
    let extractHighlightedIndex = { route: -1, train: -1 };

    // Configuration (set during init)
    let config = {
        containerId: 'extractionContainer',
        onTimetableCreated: null,
        prefilledRouteId: null,
        prefilledRouteName: null,
        prefilledTrainId: null,
        prefilledTrainName: null
    };

    const ACTIONS = [
        'WAIT FOR SERVICE',
        'STOP AT LOCATION',
        'LOAD PASSENGERS',
        'UNLOAD PASSENGERS',
        'GO VIA LOCATION',
        'UNCOUPLE VEHICLES',
        'COUPLE TO FORMATION'
    ];

    const TIME_FORMAT_REGEX = /^([0-1]?[0-9]|2[0-3]):([0-5][0-9]):([0-5][0-9])$/;

    function escapeHtml(text) {
        if (!text) return '';
        var div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    function isValidTimeFormat(time) {
        if (!time || time.trim() === '') return true;
        return TIME_FORMAT_REGEX.test(time);
    }

    function formatTimeInput(value) {
        if (!value) return '';
        if (TIME_FORMAT_REGEX.test(value)) {
            var parts = value.split(':');
            return parts[0].padStart(2, '0') + ':' + parts[1] + ':' + parts[2];
        }
        return value;
    }

    // Helper function to get translated text
    function t(key, fallback) {
        return (typeof i18n !== 'undefined' && i18n.t) ? i18n.t(key) : fallback;
    }

    /**
     * Render the extraction UI into the container
     */
    function renderUI() {
        const container = document.getElementById(config.containerId);
        if (!container) {
            console.error('Extraction container not found:', config.containerId);
            return;
        }

        // Build manual create URL with prefilled params
        let manualCreateUrl = '/timetables/create';
        const params = [];
        if (config.prefilledRouteId) params.push('route_id=' + config.prefilledRouteId);
        if (config.prefilledTrainId) params.push('train_id=' + config.prefilledTrainId);
        if (params.length > 0) manualCreateUrl += '?' + params.join('&');

        // Get translated strings
        var extractFromImages = t('timetables.extractFromImages', 'Extract from Images');
        var clickOrDrag = t('timetables.dragDropImages', 'Click or drag images here');
        var supportedFormats = t('timetables.supportedFormats', 'Supports: PNG, JPG, JPEG, GIF, BMP');
        var clearBtn = t('common.clear', 'Clear');
        var orText = t('common.or', 'OR');
        var createManually = t('timetables.createManually', 'Create Manually');
        var createNewBtn = t('timetables.createNewButton', '+ Create New Timetable');
        var createManuallyDesc = t('timetables.createManuallyDesc', 'Build a timetable from scratch by adding entries manually');
        var extractedTimetable = t('timetables.extractedTimetable', 'Extracted Timetable');
        var serviceNameLabel = t('timetables.serviceName', 'Service Name');
        var routeLabel = t('timetables.route', 'Route');
        var selectRoute = t('timetables.selectRoute', 'Select a route...');
        var trainsLabel = t('timetables.trains', 'Trains');
        var selectRouteFirst = t('timetables.selectRouteFirst', 'Select a route first...');
        var actionHeader = t('timetables.action', 'Action');
        var detailsHeader = t('timetables.detailsColumn', 'Details');
        var locationHeader = t('timetables.location', 'Location');
        var platformHeader = t('timetables.platform', 'Platform');
        var time1Header = t('timetables.time1', 'Time 1');
        var time2Header = t('timetables.time2', 'Time 2');
        var latitudeHeader = t('extraction.latitude', 'Latitude');
        var longitudeHeader = t('extraction.longitude', 'Longitude');
        var actionsHeader = t('common.actions', 'Actions');
        var createTimetableBtn = t('timetables.createNew', 'Create Timetable');
        var addRowBtn = t('extraction.addRow', 'Add Row');
        var cancelBtn = t('common.cancel', 'Cancel');
        var rawOcrOutput = t('timetables.rawOcrOutput', 'Raw OCR Output');
        var serviceTypeLabel = t('timetables.serviceType', 'Service Type');
        var passengerLabel = t('timetables.passenger', 'Passenger');
        var freightLabel = t('timetables.freight', 'Freight');

        container.innerHTML = `
            <div class="card" style="display: flex; gap: 20px; align-items: stretch; flex-wrap: wrap;">
                <div style="flex: 1; min-width: 250px;">
                    <h2>${extractFromImages}</h2>
                    <div class="upload-area" id="extractImageUploadArea">
                        <div class="upload-icon">&#128247;</div>
                        <div class="upload-text">${clickOrDrag}</div>
                        <div class="upload-hint">${supportedFormats}</div>
                        <input type="file" id="extractImageFileInput" multiple accept=".png,.jpg,.jpeg,.gif,.bmp,image/*" style="display: none;">
                    </div>
                    <div class="file-list" id="extractImageFileList"></div>
                    <div style="margin-top: 15px;">
                        <button class="btn-secondary" id="extractClearImagesBtn">${clearBtn}</button>
                    </div>
                    <div class="progress-bar" id="extractImageProgressBar">
                        <div class="fill" id="extractImageProgressFill"></div>
                    </div>
                    <div class="progress-text" id="extractImageProgressText"></div>
                    <div id="extractImageUploadStatus" class="upload-status"></div>
                </div>
                <div style="display: flex; align-items: center; color: var(--text-muted);">${orText}</div>
                <div style="flex: 1; min-width: 200px; display: flex; flex-direction: column; justify-content: center; align-items: center;">
                    <h2 style="margin-bottom: 15px;">${createManually}</h2>
                    <a href="${manualCreateUrl}" class="btn-primary" style="padding: 15px 30px; text-decoration: none; border-radius: 4px; font-size: 16px;">${createNewBtn}</a>
                    <p style="color: var(--text-muted); margin-top: 15px; font-size: 13px; text-align: center;">${createManuallyDesc}</p>
                </div>
            </div>

            <div class="card" id="extractResultsSection" style="display: none;">
                <h2>${extractedTimetable}</h2>
                <div style="display: flex; gap: 20px; flex-wrap: wrap; margin-bottom: 15px; align-items: flex-start;">
                    <div style="flex: 2; min-width: 200px;">
                        <label style="color: #888; font-size: 12px;">${serviceNameLabel} *</label>
                        <input type="text" class="service-name-input" id="extractServiceName" placeholder="${serviceNameLabel}" required>
                    </div>
                    <div style="flex: 1; min-width: 120px;">
                        <label style="color: #888; font-size: 12px;">${serviceTypeLabel}</label>
                        <select id="extractServiceType" style="width: 100%; padding: 10px; border: 1px solid var(--border-color); border-radius: 4px; background: var(--bg-primary); color: var(--text-primary); font-size: 14px;">
                            <option value="passenger">${passengerLabel}</option>
                            <option value="freight">${freightLabel}</option>
                        </select>
                    </div>
                    <div style="flex: 1; min-width: 200px;">
                        <label style="color: #888; font-size: 12px;">${routeLabel} *</label>
                        <div class="typeahead-container">
                            <input type="text" id="extractRouteInput" placeholder="${selectRoute}" autocomplete="off" required>
                            <div id="extractRouteDropdown" class="typeahead-dropdown"></div>
                            <input type="hidden" id="extractRouteId" value="">
                        </div>
                    </div>
                    <div style="flex: 1; min-width: 200px;">
                        <label style="color: #888; font-size: 12px;">${trainsLabel} *</label>
                        <div class="typeahead-container">
                            <input type="text" id="extractTrainInput" placeholder="${selectRouteFirst}" autocomplete="off" disabled>
                            <div id="extractTrainDropdown" class="typeahead-dropdown"></div>
                        </div>
                        <div id="extractSelectedTrains" style="margin-top: 8px;"></div>
                    </div>
                </div>

                <div id="extractTableContainer">
                    <table id="extractResultsTable">
                        <thead>
                            <tr>
                                <th>#</th>
                                <th>${actionHeader}</th>
                                <th>${detailsHeader}</th>
                                <th>${locationHeader}</th>
                                <th>${platformHeader}</th>
                                <th>${time1Header}</th>
                                <th>${time2Header}</th>
                                <th>${latitudeHeader}</th>
                                <th>${longitudeHeader}</th>
                                <th class="actions">${actionsHeader}</th>
                            </tr>
                        </thead>
                        <tbody id="extractTableBody"></tbody>
                    </table>
                </div>

                <div style="margin-top: 15px;">
                    <button class="btn-success" id="extractCreateBtn">${createTimetableBtn}</button>
                    <button class="btn-secondary" id="extractAddRowBtn">${addRowBtn}</button>
                    <button class="btn-secondary" id="extractCancelBtn" style="margin-left: 20px;">${cancelBtn}</button>
                </div>

                <div style="margin-top: 20px;">
                    <h3 class="collapsible collapsed" id="extractRawToggle">${rawOcrOutput}</h3>
                    <div class="collapsible-content hidden" id="extractRawContent">
                        <div class="raw-text" id="extractRawText"></div>
                    </div>
                </div>
            </div>
        `;

        setupEventListeners();
    }

    /**
     * Setup all event listeners
     */
    function setupEventListeners() {
        const imageUploadArea = document.getElementById('extractImageUploadArea');
        const imageFileInput = document.getElementById('extractImageFileInput');
        const clearImagesBtn = document.getElementById('extractClearImagesBtn');

        // Upload area events
        imageUploadArea.addEventListener('click', function() { imageFileInput.click(); });
        imageFileInput.addEventListener('change', function(e) { handleImageFiles(e.target.files); });

        imageUploadArea.addEventListener('dragover', function(e) {
            e.preventDefault();
            imageUploadArea.classList.add('dragover');
        });
        imageUploadArea.addEventListener('dragleave', function() {
            imageUploadArea.classList.remove('dragover');
        });
        imageUploadArea.addEventListener('drop', function(e) {
            e.preventDefault();
            imageUploadArea.classList.remove('dragover');
            handleImageFiles(e.dataTransfer.files);
        });

        // Clear images button
        clearImagesBtn.addEventListener('click', function() {
            selectedImageFiles = [];
            imageFileInput.value = '';
            renderImageFileList();
            document.getElementById('extractImageUploadStatus').className = 'upload-status';
            document.getElementById('extractImageUploadStatus').textContent = '';
        });

        // Add row button
        document.getElementById('extractAddRowBtn').addEventListener('click', function() {
            extractedEntries.push({
                action: 'STOP AT LOCATION',
                details: '',
                location: '',
                platform: '',
                time1: '',
                time2: '',
                latitude: '',
                longitude: ''
            });
            renderExtractedTable();
        });

        // Cancel button
        document.getElementById('extractCancelBtn').addEventListener('click', function() {
            var discardMsg = t('extraction.discardData', 'Discard extracted data?');
            if (extractedEntries.length > 0 && !confirm(discardMsg)) return;
            resetExtraction();
        });

        // Create button
        document.getElementById('extractCreateBtn').addEventListener('click', createTimetable);

        // Raw text toggle (collapsible)
        document.getElementById('extractRawToggle').addEventListener('click', function() {
            this.classList.toggle('collapsed');
            var content = document.getElementById('extractRawContent');
            content.classList.toggle('hidden');
        });

        // Close dropdowns when clicking outside
        document.addEventListener('click', function(e) {
            if (!e.target.closest('.typeahead-container')) {
                const routeDropdown = document.getElementById('extractRouteDropdown');
                const trainDropdown = document.getElementById('extractTrainDropdown');
                if (routeDropdown) routeDropdown.style.display = 'none';
                if (trainDropdown) trainDropdown.style.display = 'none';
            }
        });
    }

    /**
     * Handle image file selection
     */
    function handleImageFiles(files) {
        for (var i = 0; i < files.length; i++) {
            if (/\.(png|jpg|jpeg|gif|bmp)$/i.test(files[i].name)) {
                selectedImageFiles.push(files[i]);
            }
        }
        selectedImageFiles.sort(function(a, b) { return a.name.localeCompare(b.name); });
        renderImageFileList();

        // Auto-process images immediately after upload
        if (selectedImageFiles.length > 0) {
            processImages();
        }
    }

    /**
     * Render the list of selected image files
     */
    function renderImageFileList() {
        const fileList = document.getElementById('extractImageFileList');
        fileList.innerHTML = selectedImageFiles.map(function(file, index) {
            return '<div class="file-item"><span>' + (index + 1) + '. ' + escapeHtml(file.name) + ' (' + (file.size / 1024).toFixed(1) + ' KB)</span></div>';
        }).join('');
    }

    /**
     * Process uploaded images via OCR
     */
    async function processImages() {
        if (selectedImageFiles.length === 0) return;

        const progressBar = document.getElementById('extractImageProgressBar');
        const progressFill = document.getElementById('extractImageProgressFill');
        const progressText = document.getElementById('extractImageProgressText');
        const uploadStatus = document.getElementById('extractImageUploadStatus');

        progressBar.style.display = 'block';
        progressFill.style.width = '0%';
        progressText.textContent = t('extraction.uploadingImages', 'Uploading images...');
        uploadStatus.className = 'upload-status';

        var formData = new FormData();
        selectedImageFiles.forEach(function(file) { formData.append('images', file, file.name); });

        try {
            var response = await fetch('/api/extract', {
                method: 'POST',
                body: formData
            });

            if (!response.ok) {
                var error = await response.json();
                throw new Error(error.error || t('extraction.processingFailed', 'Processing failed'));
            }

            progressFill.style.width = '100%';
            progressText.textContent = t('extraction.complete', 'Complete!');

            var data = await response.json();
            displayExtractedResults(data);

        } catch (error) {
            progressText.textContent = 'Error: ' + error.message;
            uploadStatus.className = 'upload-status error';
            uploadStatus.textContent = 'Error: ' + error.message;
            console.error('Error:', error);
        } finally {
            setTimeout(function() {
                progressBar.style.display = 'none';
                progressFill.style.width = '0%';
            }, 2000);
        }
    }

    /**
     * Display extracted results
     */
    function displayExtractedResults(data) {
        extractedEntries = data.entries || [];
        document.getElementById('extractServiceName').value = data.service_name || '';
        document.getElementById('extractServiceType').value = 'passenger';
        document.getElementById('extractResultsSection').style.display = 'block';

        // Reset route/train selection
        extractRouteTrains = [];
        extractSelectedTrains = [];
        document.getElementById('extractRouteId').value = '';
        document.getElementById('extractRouteInput').value = '';
        document.getElementById('extractTrainInput').value = '';
        document.getElementById('extractTrainInput').disabled = true;
        document.getElementById('extractTrainInput').placeholder = t('timetables.selectRouteFirst', 'Select a route first...');
        renderExtractSelectedTrains();

        // Setup route/train typeaheads
        setupExtractRouteTypeahead();
        setupExtractTrainTypeahead();

        // Apply prefilled values if configured
        if (config.prefilledRouteId && config.prefilledRouteName) {
            selectExtractRoute(config.prefilledRouteId, config.prefilledRouteName);
        }

        // Raw text
        const rawTextEl = document.getElementById('extractRawText');
        if (data.rawTexts && data.rawTexts.length > 0) {
            rawTextEl.textContent = data.rawTexts.map(function(r) {
                return '=== ' + r.file + ' ===\n' + r.text;
            }).join('\n\n');
        }

        renderExtractedTable();

        // Scroll to results
        document.getElementById('extractResultsSection').scrollIntoView({ behavior: 'smooth' });
    }

    /**
     * Setup route typeahead
     */
    function setupExtractRouteTypeahead() {
        var input = document.getElementById('extractRouteInput');
        var dropdown = document.getElementById('extractRouteDropdown');
        var hidden = document.getElementById('extractRouteId');

        input.addEventListener('focus', function() { showExtractRouteDropdown(this.value); });
        input.addEventListener('input', function() {
            extractHighlightedIndex.route = -1;
            hidden.value = '';
            showExtractRouteDropdown(this.value);
        });
        input.addEventListener('keydown', function(e) {
            var items = dropdown.querySelectorAll('.typeahead-item[data-id]');
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                extractHighlightedIndex.route = Math.min(extractHighlightedIndex.route + 1, items.length - 1);
                updateHighlight(items, extractHighlightedIndex.route);
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                extractHighlightedIndex.route = Math.max(extractHighlightedIndex.route - 1, 0);
                updateHighlight(items, extractHighlightedIndex.route);
            } else if (e.key === 'Enter') {
                e.preventDefault();
                if (extractHighlightedIndex.route >= 0 && items[extractHighlightedIndex.route]) {
                    items[extractHighlightedIndex.route].click();
                }
            } else if (e.key === 'Escape') {
                dropdown.style.display = 'none';
            }
        });
    }

    function showExtractRouteDropdown(filter) {
        var dropdown = document.getElementById('extractRouteDropdown');
        var filterLower = (filter || '').toLowerCase();

        var filtered = allRoutes.filter(function(route) {
            return route.name.toLowerCase().includes(filterLower) ||
                (route.country_name && route.country_name.toLowerCase().includes(filterLower));
        }).slice(0, 10);

        if (filtered.length === 0) {
            dropdown.innerHTML = '<div class="typeahead-item" style="color: var(--text-muted);">' + t('timetables.noRoutesFound', 'No routes found') + '</div>';
        } else {
            dropdown.innerHTML = filtered.map(function(route) {
                return '<div class="typeahead-item" data-id="' + route.id + '" data-name="' + escapeHtml(route.name) + '">' +
                    '<div class="item-name">' + escapeHtml(route.name) + '</div>' +
                    (route.country_name ? '<div class="item-sub">' + escapeHtml(route.country_name) + '</div>' : '') +
                    '</div>';
            }).join('');

            dropdown.querySelectorAll('.typeahead-item[data-id]').forEach(function(item) {
                item.addEventListener('click', function() {
                    selectExtractRoute(parseInt(this.dataset.id), this.dataset.name);
                });
            });
        }
        dropdown.style.display = 'block';
    }

    async function selectExtractRoute(id, name) {
        document.getElementById('extractRouteInput').value = name;
        document.getElementById('extractRouteId').value = id;
        document.getElementById('extractRouteDropdown').style.display = 'none';
        extractHighlightedIndex.route = -1;

        // Clear selected trains when route changes
        extractSelectedTrains = [];
        renderExtractSelectedTrains();

        // Fetch trains for this route
        try {
            var response = await fetch('/api/routes/' + id + '/trains');
            extractRouteTrains = await response.json();
        } catch (err) {
            console.error('Failed to load trains for route:', err);
            extractRouteTrains = [];
        }

        // Enable train input
        var trainInput = document.getElementById('extractTrainInput');
        trainInput.disabled = false;
        trainInput.placeholder = extractRouteTrains.length > 0
            ? t('timetables.typeToSearchTrains', 'Type to search and add trains...')
            : t('timetables.noTrainsAvailable', 'No trains available for this route');

        // Apply prefilled train if configured
        if (config.prefilledTrainId && config.prefilledTrainName) {
            // Check if this train is in the route's trains
            const trainExists = extractRouteTrains.some(function(t) { return t.id == config.prefilledTrainId; });
            if (trainExists) {
                addExtractTrain(parseInt(config.prefilledTrainId), config.prefilledTrainName);
            }
        }
    }

    /**
     * Setup train typeahead
     */
    function setupExtractTrainTypeahead() {
        var input = document.getElementById('extractTrainInput');
        var dropdown = document.getElementById('extractTrainDropdown');

        input.addEventListener('focus', function() { showExtractTrainDropdown(this.value); });
        input.addEventListener('input', function() {
            extractHighlightedIndex.train = -1;
            showExtractTrainDropdown(this.value);
        });
        input.addEventListener('keydown', function(e) {
            var items = dropdown.querySelectorAll('.typeahead-item[data-id]');
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                extractHighlightedIndex.train = Math.min(extractHighlightedIndex.train + 1, items.length - 1);
                updateHighlight(items, extractHighlightedIndex.train);
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                extractHighlightedIndex.train = Math.max(extractHighlightedIndex.train - 1, 0);
                updateHighlight(items, extractHighlightedIndex.train);
            } else if (e.key === 'Enter') {
                e.preventDefault();
                if (extractHighlightedIndex.train >= 0 && items[extractHighlightedIndex.train]) {
                    items[extractHighlightedIndex.train].click();
                }
            } else if (e.key === 'Escape') {
                dropdown.style.display = 'none';
            }
        });
    }

    function showExtractTrainDropdown(filter) {
        var dropdown = document.getElementById('extractTrainDropdown');
        var routeId = document.getElementById('extractRouteId').value;

        if (!routeId || extractRouteTrains.length === 0) {
            var msg = routeId ? t('timetables.noTrainsAvailable', 'No trains available for this route') : t('timetables.selectRouteFirst', 'Please select a route first');
            dropdown.innerHTML = '<div class="typeahead-item" style="color: var(--text-muted);">' + msg + '</div>';
            dropdown.style.display = 'block';
            return;
        }

        var filterLower = (filter || '').toLowerCase();
        var selectedIds = extractSelectedTrains.map(function(t) { return t.id; });

        var filtered = extractRouteTrains.filter(function(train) {
            return !selectedIds.includes(train.id) &&
                train.name.toLowerCase().includes(filterLower);
        }).slice(0, 10);

        if (filtered.length === 0) {
            dropdown.innerHTML = '<div class="typeahead-item" style="color: var(--text-muted);">' + t('extraction.noMoreTrains', 'No more trains available') + '</div>';
        } else {
            dropdown.innerHTML = filtered.map(function(train) {
                var label = escapeHtml(train.name);
                if (train.class_name) {
                    label += ' <span style="color: var(--text-muted);">(' + escapeHtml(train.class_name) + ')</span>';
                }
                return '<div class="typeahead-item" data-id="' + train.id + '" data-name="' + escapeHtml(train.name) + '">' +
                    '<div class="item-name">' + label + '</div></div>';
            }).join('');

            dropdown.querySelectorAll('.typeahead-item[data-id]').forEach(function(item) {
                item.addEventListener('click', function() {
                    addExtractTrain(parseInt(this.dataset.id), this.dataset.name);
                });
            });
        }
        dropdown.style.display = 'block';
    }

    function addExtractTrain(id, name) {
        if (extractSelectedTrains.some(function(t) { return t.id === id; })) return;

        extractSelectedTrains.push({ id: id, name: name });
        document.getElementById('extractTrainInput').value = '';
        document.getElementById('extractTrainDropdown').style.display = 'none';
        extractHighlightedIndex.train = -1;
        renderExtractSelectedTrains();
    }

    // Make this function globally accessible for onclick handlers
    window.removeExtractTrain = function(id) {
        extractSelectedTrains = extractSelectedTrains.filter(function(t) { return t.id !== id; });
        renderExtractSelectedTrains();
    };

    function renderExtractSelectedTrains() {
        var container = document.getElementById('extractSelectedTrains');
        if (extractSelectedTrains.length === 0) {
            container.innerHTML = '';
            return;
        }
        container.innerHTML = extractSelectedTrains.map(function(train) {
            return '<span class="selected-train-tag">' + escapeHtml(train.name) +
                '<button type="button" class="remove-train" onclick="removeExtractTrain(' + train.id + ')">&times;</button></span>';
        }).join('');
    }

    function updateHighlight(items, activeIndex) {
        items.forEach(function(item, idx) {
            item.classList.toggle('highlighted', idx === activeIndex);
        });
        if (activeIndex >= 0 && items[activeIndex]) {
            items[activeIndex].scrollIntoView({ block: 'nearest' });
        }
    }

    /**
     * Render the extracted entries table
     */
    function renderExtractedTable() {
        const tbody = document.getElementById('extractTableBody');
        var selectText = t('common.select', '-- Select --');
        var deleteText = t('common.delete', 'Delete');

        tbody.innerHTML = extractedEntries.map(function(entry, index) {
            var actionOptions = ACTIONS.map(function(a) {
                return '<option value="' + a + '"' + (entry.action === a ? ' selected' : '') + '>' + a + '</option>';
            }).join('');

            return '<tr data-index="' + index + '">' +
                '<td>' + (index + 1) + '</td>' +
                '<td><select class="action-select" onchange="ExtractionModule.updateExtractedField(' + index + ', \'action\', this.value)"><option value="">' + selectText + '</option>' + actionOptions + '</select></td>' +
                '<td class="editable-cell" data-field="details">' + escapeHtml(entry.details || '') + '</td>' +
                '<td class="editable-cell" data-field="location">' + escapeHtml(entry.location || '') + '</td>' +
                '<td class="editable-cell" data-field="platform">' + escapeHtml(entry.platform || '') + '</td>' +
                '<td class="editable-cell" data-field="time1">' + escapeHtml(entry.time1 || '') + '</td>' +
                '<td class="editable-cell" data-field="time2">' + escapeHtml(entry.time2 || '') + '</td>' +
                '<td class="editable-cell" data-field="latitude">' + escapeHtml(entry.latitude || '') + '</td>' +
                '<td class="editable-cell" data-field="longitude">' + escapeHtml(entry.longitude || '') + '</td>' +
                '<td class="actions"><button class="btn-danger" onclick="ExtractionModule.deleteExtractedRow(' + index + ')">' + deleteText + '</button></td>' +
                '</tr>';
        }).join('');

        // Add click handlers for editable cells
        document.querySelectorAll('#extractTableBody .editable-cell').forEach(function(cell) {
            cell.addEventListener('click', makeExtractedCellEditable);
        });
    }

    function makeExtractedCellEditable(e) {
        var cell = e.target;
        if (cell.querySelector('input')) return;

        var currentValue = cell.textContent;
        var field = cell.dataset.field;
        var row = cell.parentElement;
        var index = parseInt(row.dataset.index);

        var input = document.createElement('input');
        input.type = 'text';
        input.value = currentValue;

        input.addEventListener('blur', function() {
            var newValue = input.value;
            extractedEntries[index][field] = newValue;
            cell.textContent = newValue;
        });

        input.addEventListener('keydown', function(e) {
            if (e.key === 'Enter') {
                input.blur();
            } else if (e.key === 'Escape') {
                cell.textContent = currentValue;
            }
        });

        cell.textContent = '';
        cell.appendChild(input);
        input.focus();
        input.select();
    }

    /**
     * Create the timetable from extracted data
     */
    async function createTimetable() {
        // Validate service name
        var serviceName = document.getElementById('extractServiceName').value.trim();
        if (!serviceName) {
            alert(t('extraction.enterServiceName', 'Please enter a service name'));
            document.getElementById('extractServiceName').focus();
            return;
        }

        // Validate route is selected
        var routeId = document.getElementById('extractRouteId').value;
        if (!routeId) {
            alert(t('extraction.selectRoute', 'Please select a route'));
            document.getElementById('extractRouteInput').focus();
            return;
        }

        // Validate at least one train is selected
        if (extractSelectedTrains.length === 0) {
            alert(t('extraction.selectTrain', 'Please select at least one train'));
            document.getElementById('extractTrainInput').focus();
            return;
        }

        // Validate entries exist
        if (extractedEntries.length === 0) {
            alert(t('extraction.noEntries', 'No entries to save'));
            return;
        }

        // Validate time format for all entries (HH:MM:SS)
        var invalidTimes = [];
        extractedEntries.forEach(function(entry, index) {
            if (entry.time1 && !isValidTimeFormat(entry.time1)) {
                invalidTimes.push(t('extraction.entry', 'Entry') + ' ' + (index + 1) + ' ' + t('timetables.time1', 'Time 1') + ': "' + entry.time1 + '"');
            }
            if (entry.time2 && !isValidTimeFormat(entry.time2)) {
                invalidTimes.push(t('extraction.entry', 'Entry') + ' ' + (index + 1) + ' ' + t('timetables.time2', 'Time 2') + ': "' + entry.time2 + '"');
            }
        });
        if (invalidTimes.length > 0) {
            alert(t('extraction.invalidTimeFormat', 'Invalid time format. Times must be HH:MM:SS (e.g., 08:30:00).') + '\n\n' + invalidTimes.join('\n'));
            return;
        }

        const uploadStatus = document.getElementById('extractImageUploadStatus');

        try {
            var serviceType = document.getElementById('extractServiceType').value;
            var payload = {
                service_name: serviceName,
                service_type: serviceType,
                route_id: parseInt(routeId),
                train_ids: extractSelectedTrains.map(function(t) { return t.id; }),
                entries: extractedEntries.map(function(entry) {
                    return {
                        action: entry.action || '',
                        details: entry.details || '',
                        location: entry.location || '',
                        platform: entry.platform || '',
                        time1: formatTimeInput(entry.time1 || ''),
                        time2: formatTimeInput(entry.time2 || ''),
                        latitude: entry.latitude || '',
                        longitude: entry.longitude || ''
                    };
                })
            };

            var response = await fetch('/api/timetables', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            var result = await response.json();

            if (!response.ok) {
                throw new Error(result.error || 'Failed to create timetable');
            }

            uploadStatus.className = 'upload-status success';
            uploadStatus.textContent = t('extraction.timetableCreated', 'Timetable created! Redirecting...');

            // Call callback if provided
            if (config.onTimetableCreated) {
                config.onTimetableCreated(result);
            }

            setTimeout(function() {
                window.location.href = '/timetables/' + result.id;
            }, 1000);

        } catch (error) {
            alert(t('extraction.errorCreating', 'Error creating timetable: ') + error.message);
            console.error('Error:', error);
        }
    }

    /**
     * Reset the extraction form
     */
    function resetExtraction() {
        extractedEntries = [];
        document.getElementById('extractServiceName').value = '';
        document.getElementById('extractServiceType').value = 'passenger';
        var rawTextEl = document.getElementById('extractRawText');
        if (rawTextEl) rawTextEl.textContent = '';

        // Reset route/train selection
        extractRouteTrains = [];
        extractSelectedTrains = [];
        document.getElementById('extractRouteId').value = '';
        document.getElementById('extractRouteInput').value = '';
        document.getElementById('extractTrainInput').value = '';
        document.getElementById('extractTrainInput').disabled = true;
        document.getElementById('extractTrainInput').placeholder = t('timetables.selectRouteFirst', 'Select a route first...');
        document.getElementById('extractSelectedTrains').innerHTML = '';

        document.getElementById('extractResultsSection').style.display = 'none';
    }

    /**
     * Initialize the extraction module
     */
    async function init(options) {
        config = Object.assign(config, options || {});

        // Load routes
        try {
            var response = await fetch('/api/routes');
            allRoutes = await response.json();
        } catch (err) {
            console.error('Failed to load routes:', err);
        }

        renderUI();
    }

    // Public API
    return {
        init: init,
        updateExtractedField: function(index, field, value) {
            extractedEntries[index][field] = value;
        },
        deleteExtractedRow: function(index) {
            if (!confirm(t('extraction.deleteRow', 'Delete this row?'))) return;
            extractedEntries.splice(index, 1);
            renderExtractedTable();
        }
    };
})();
