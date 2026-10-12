(() => {
  const $d = (id) => document.getElementById(id);
  const profileDefaults = {
    sedan: { width: 1.9, height: 2.0, weight: 3.5 },
    box: { width: 2.5, height: 3.8, weight: 7.5 },
    semi: { width: 2.6, height: 4.2, weight: 40 }
  };
  const deliveryStops = [];
  let selectedPlace = null;
  let suggestionTimer = null;
  let activeStop = null;
  let arrivalFix = null;
  let photoBase64 = null;
  let photoMimeType = null;
  let photoReading = false;
  let signaturePoints = [];
  let signatureDrawing = false;
  let deliveryLayers = [];
  let deliveryPlan = null;
  let geofenceWatchId = null;
  let lastTrackingPosition = null;
  let lastTrackingRefresh = 0;

  const signatureCanvas = $d('signature-pad');
  const signatureContext = signatureCanvas.getContext('2d');
  signatureContext.lineWidth = 5;
  signatureContext.lineCap = 'round';
  signatureContext.lineJoin = 'round';
  signatureContext.strokeStyle = '#16364a';

  function updateProfileDefaults() {
    const defaults = profileDefaults[$d('delivery-vehicle').value];
    $d('vehicle-width').value = defaults.width;
    $d('vehicle-height').value = defaults.height;
    $d('vehicle-weight').value = defaults.weight;
  }
  $d('delivery-vehicle').addEventListener('change', updateProfileDefaults);
  updateProfileDefaults();

  function escape(value) {
    return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function renderStopQueue() {
    if (!deliveryStops.length) {
      $d('delivery-stop-queue').innerHTML = '<span class="queue-empty">No stops added yet.</span>';
      return;
    }
    $d('delivery-stop-queue').innerHTML = deliveryStops.map((stop, index) => `<div class="queued-stop"><span>${index + 1}</span><div><b>${escape(stop.name)}</b><small>${escape(stop.label)}</small></div><button type="button" data-remove-stop="${escape(stop.id)}" aria-label="Remove ${escape(stop.name)}">×</button></div>`).join('');
    $d('delivery-stop-queue').querySelectorAll('[data-remove-stop]').forEach((button) => button.addEventListener('click', () => {
      const index = deliveryStops.findIndex((stop) => stop.id === button.dataset.removeStop);
      if (index >= 0) deliveryStops.splice(index, 1);
      deliveryPlan = null;
      removeDeliveryLayers();
      $d('delivery-run-results').classList.add('hidden');
      renderStopQueue();
    }));
  }

  $d('delivery-stop-input').addEventListener('input', () => {
    clearTimeout(suggestionTimer);
    selectedPlace = null;
    const query = $d('delivery-stop-input').value.trim();
    if (!query) { $d('delivery-suggestions').innerHTML = ''; return; }
    suggestionTimer = setTimeout(async () => {
      $d('delivery-suggestions').innerHTML = '<div class="suggestion-hint">Searching Hyderabad…</div>';
      try {
        const places = await geocode(query);
        if ($d('delivery-stop-input').value.trim() !== query) return;
        $d('delivery-suggestions').innerHTML = places.length ? places.map((place, index) => `<button type="button" class="suggestion" data-place-index="${index}">${escape(place.name)}<small>${escape(place.display_name)}</small></button>`).join('') : '<div class="suggestion-hint">No matching places in Hyderabad.</div>';
        $d('delivery-suggestions').querySelectorAll('[data-place-index]').forEach((button) => button.addEventListener('click', () => {
          selectedPlace = places[Number(button.dataset.placeIndex)];
          $d('delivery-stop-input').value = selectedPlace.display_name;
          $d('delivery-suggestions').innerHTML = '';
        }));
      } catch (error) {
        $d('delivery-suggestions').innerHTML = `<div class="suggestion-hint">${escape(error.message)}</div>`;
      }
    }, 350);
  });

  async function addDeliveryStop() {
    if (deliveryStops.length >= 12) { toast('This demo supports up to 12 stops per delivery run.'); return; }
    if (!selectedPlace) {
      const query = $d('delivery-stop-input').value.trim();
      if (!query) { $d('delivery-stop-input').focus(); return; }
      try {
        const places = await geocode(query);
        if (!places.length) { toast('Choose a suggested Hyderabad place before adding the stop.'); return; }
        selectedPlace = places[0];
      } catch (error) { toast(error.message); return; }
    }
    const place = selectedPlace;
    if (deliveryStops.some((stop) => Math.abs(stop.lat - place.lat) < 0.0003 && Math.abs(stop.lon - place.lon) < 0.0003)) {
      toast('That delivery stop is already in the run.');
      return;
    }
    deliveryStops.push({
      id: globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      name: place.name,
      label: place.display_name,
      lat: place.lat,
      lon: place.lon,
      customerPhone: $d('delivery-customer').value.trim(),
      state: 'queued',
      arrivalVerified: false,
      otpSent: false,
      otpVerified: false,
      proof: null
    });
    selectedPlace = null;
    $d('delivery-stop-input').value = '';
    $d('delivery-customer').value = '';
    $d('delivery-suggestions').innerHTML = '';
    $d('delivery-run-results').classList.add('hidden');
    deliveryPlan = null;
    removeDeliveryLayers();
    renderStopQueue();
  }
  $d('add-delivery-stop').addEventListener('click', addDeliveryStop);
  $d('delivery-stop-input').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); addDeliveryStop(); }
    if (event.key === 'Escape') $d('delivery-suggestions').innerHTML = '';
  });

  function haversineMeters(a, b) {
    const toRadians = (degrees) => degrees * Math.PI / 180;
    const dLat = toRadians(b.lat - a.lat), dLon = toRadians(b.lon - a.lon);
    const lat1 = toRadians(a.lat), lat2 = toRadians(b.lat);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
    return 6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  }
  function orderStopsNearestNeighbor(stops) {
    const remaining = [...stops], ordered = [];
    let cursor = { lat: start.lat, lon: start.lon };
    while (remaining.length) {
      let bestIndex = 0, bestDistance = Infinity;
      remaining.forEach((stop, index) => {
        const distance = haversineMeters(cursor, stop);
        if (distance < bestDistance) { bestDistance = distance; bestIndex = index; }
      });
      const [next] = remaining.splice(bestIndex, 1);
      ordered.push(next);
      cursor = next;
    }
    return ordered;
  }
  function profileFromForm() {
    const profile = $d('delivery-vehicle').value;
    const width = Number($d('vehicle-width').value), height = Number($d('vehicle-height').value), weight = Number($d('vehicle-weight').value);
    if (!(width > 0 && width <= 4 && height > 0 && height <= 6 && weight > 0 && weight <= 80)) throw Error('Enter realistic vehicle dimensions and gross weight.');
    return { kind: profile, width, height, weight };
  }
  function profileTitle(kind) {
    return ({ sedan: 'Sedan', box: 'Box Truck', semi: 'Semi-Trailer' })[kind] || 'Vehicle';
  }
  function routeRoadNames(route) {
    return [...new Set((route.legs || []).flatMap((leg) => (leg.steps || []).map((step) => step.name).filter(Boolean)))];
  }
  function possibleNarrowRoads(route) {
    return routeRoadNames(route).filter((name) => /\b(lane|gali|service road)\b/i.test(name));
  }
  function vehicleRouteScore(route, profile) {
    const narrowRoadCount = possibleNarrowRoads(route).length;
    const sizeFactor = Math.max(profile.width / 1.9, profile.height / 2.1, profile.weight / 3.5);
    const penaltySeconds = profile.kind === 'sedan' ? 0 : narrowRoadCount * Math.min(5400, Math.max(0, Math.round((sizeFactor - 1) * 1800)));
    return route.duration + penaltySeconds;
  }
  function chooseVehicleRoute(routeSet, profile) {
    return [...routeSet].sort((a, b) => vehicleRouteScore(a, profile) - vehicleRouteScore(b, profile))[0];
  }
  function formatClock(minutesFromNow) {
    return new Date(Date.now() + minutesFromNow * 60000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  function coordinateAtFraction(route, fraction) {
    const points = route.geometry?.coordinates || [];
    if (!points.length) return { lat: destination?.lat || start.lat, lon: destination?.lon || start.lon };
    const point = points[Math.min(points.length - 1, Math.max(0, Math.round((points.length - 1) * fraction)))];
    return { lon: point[0], lat: point[1] };
  }
  function breaksDuringLeg(route, legMinutes, driveSinceBreak, intervalMinutes, breakMinutes, elapsedBefore) {
    const breaks = [];
    let remaining = legMinutes, progress = 0, sinceBreak = driveSinceBreak;
    while (remaining > 0 && sinceBreak + remaining >= intervalMinutes) {
      const untilBreak = intervalMinutes - sinceBreak;
      if (untilBreak <= 0) break;
      progress += untilBreak;
      remaining -= untilBreak;
      const breakIndex = breaks.length;
      breaks.push({
        fraction: Math.min(1, progress / Math.max(legMinutes, 0.01)),
        point: coordinateAtFraction(route, progress / Math.max(legMinutes, 0.01)),
        atMinutes: elapsedBefore + progress + breakIndex * breakMinutes
      });
      sinceBreak = 0;
    }
    sinceBreak += remaining;
    return { breaks, driveSinceBreak: sinceBreak, elapsedMinutes: legMinutes + breaks.length * breakMinutes };
  }

  function removeDeliveryLayers() {
    deliveryLayers.forEach((layer) => map.removeLayer(layer));
    deliveryLayers = [];
  }
  window.clearDeliveryPlanOverlay = () => {
    removeDeliveryLayers();
    $d('delivery-run-results').classList.add('hidden');
  };
  function drawDeliveryPlan(plan) {
    removeDeliveryLayers();
    const mapBounds = [];
    plan.assigned.forEach((stop, index) => {
      const routeCoordinates = stop.route.geometry.coordinates.map(([lon, lat]) => [lat, lon]);
      const line = L.polyline(routeCoordinates, { color: COLORS[index % COLORS.length], weight: 6, opacity: 0.86 }).addTo(map);
      deliveryLayers.push(line);
      mapBounds.push(line.getBounds());
      const marker = L.marker([stop.lat, stop.lon], { icon: L.divIcon({ className: 'route-map-number', html: `<span style="--route-color:${COLORS[index % COLORS.length]}">${index + 1}</span>`, iconSize: [30, 30], iconAnchor: [15, 15] }) }).addTo(map).bindPopup(`Delivery stop ${index + 1}: ${escape(stop.name)}`);
      deliveryLayers.push(marker);
    });
    plan.breaks.forEach((breakNode, index) => {
      const marker = L.circleMarker([breakNode.lat, breakNode.lon], { radius: 9, color: '#fff', weight: 3, fillColor: '#ef9d3d', fillOpacity: 1 }).addTo(map).bindPopup(`Break ${index + 1}: simulated 30-minute rest near this route point`);
      deliveryLayers.push(marker);
    });
    if (locateMarker) locateMarker.addTo(map);
    if (mapBounds.length) {
      const bounds = L.featureGroup(deliveryLayers).getBounds();
      map.fitBounds(bounds.pad(0.14), { maxZoom: 14 });
    }
    $('map-from').textContent = start.label || 'Starting point';
    $('map-to').textContent = `${plan.assigned.length} assigned stop${plan.assigned.length === 1 ? '' : 's'}`;
    $('map-duration').textContent = fmtTime(plan.elapsedMinutes * 60);
    $('map-distance').textContent = fmtDistance(plan.distanceMeters);
    $('map-fuel-label').textContent = 'VEHICLE';
    $('map-fuel').textContent = profileTitle(plan.profile.kind);
    $('legend-primary-text').textContent = 'Delivery legs';
    $('legend-alt-text').textContent = 'Rest break';
    $('legend-alt-icon').classList.add('break-legend');
    setMapStatus('Delivery run planned');
  }
  function renderRun(plan) {
    $d('delivery-run-results').classList.remove('hidden');
    const totalStops = plan.assigned.length + plan.pending.length;
    $d('delivery-run-summary').innerHTML = `<b>${plan.assigned.length} assigned</b> · ${plan.pending.length} pending · ${plan.breaks.length} break${plan.breaks.length === 1 ? '' : 's'} · ${fmtDistance(plan.distanceMeters)} · ${fmtTime(plan.elapsedMinutes * 60)} total shift time`;
    $d('delivery-timeline').innerHTML = plan.timeline.map((item) => item.type === 'break'
      ? `<div class="delivery-timeline-item break-item"><span class="timeline-marker">☕</span><div><b>Break node · ${item.minutes} min rest</b><small>Simulated stop near the route at about ${formatClock(item.atMinutes)}. The point is not verified as a rest facility.</small></div></div>`
      : `<article class="delivery-timeline-item stop-item"><span class="timeline-marker">${item.sequence}</span><div class="delivery-stop-copy"><b>Stop ${item.sequence} · ${escape(item.name)}</b><small>${escape(item.label)} · ${item.liveEtaAt ? `Live ETA ${new Date(item.liveEtaAt).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}` : `Planned ETA ${formatClock(item.etaMinutes)}`} · ${fmtDistance(item.distanceMeters)} from previous stop${item.customerPhone ? ` · SMS ${escape(item.customerPhone)}` : ''}</small>${item.accessWarnings.length ? `<small class="access-warning">Vehicle access check: ${escape(item.accessWarnings.join(', '))} may be restrictive. Verify locally.</small>` : ''}<div class="delivery-stop-actions">${item.customerPhone && item.state !== 'complete' ? `<button type="button" class="send-stop-otp-btn" data-send-stop-otp="${escape(item.id)}">${item.otpSent ? 'Resend customer OTP' : 'Send customer OTP'}</button><small>${item.otpVerified ? 'Customer OTP verified' : item.otpSent ? 'SMS OTP sent · awaiting verification' : 'SMS OTP required for proof of delivery'}</small>` : ''}${item.state === 'complete' ? '<span class="complete-badge">Completed · PoD saved</span>' : `<button type="button" class="mark-complete-btn ${item.arrivalVerified ? 'arrival-verified' : ''}" data-complete-stop="${escape(item.id)}">${item.arrivalVerified ? 'Arrival verified · capture PoD' : 'Check arrival & complete'}</button>`}</div></div></article>`).join('') || '<div class="queue-empty">No stops fit inside this shift window.</div>';
    $d('delivery-pending').innerHTML = plan.pending.length ? plan.pending.map((stop, index) => `<div class="pending-stop"><span>${index + 1}</span><div><b>${escape(stop.name)}</b><small>${escape(stop.label)}</small></div><strong>Pending / unassigned</strong></div>`).join('') : 'None';
    $d('delivery-timeline').querySelectorAll('[data-complete-stop]').forEach((button) => button.addEventListener('click', () => checkArrival(button.dataset.completeStop)));
    $d('delivery-timeline').querySelectorAll('[data-send-stop-otp]').forEach((button) => button.addEventListener('click', () => sendDeliveryOtp(button.dataset.sendStopOtp)));
    $d('delivery-run-summary').dataset.totalStops = String(totalStops);
  }

  async function planDeliveryRun() {
    if (!start) { toast('Allow location access or click the map to select a start point first.'); locate(); return; }
    if (!deliveryStops.length) { toast('Add at least one delivery stop.'); return; }
    let profile;
    try { profile = profileFromForm(); } catch (error) { toast(error.message); return; }
    const shiftHours = Number($d('shift-cap').value), breakAfterHours = Number($d('break-after').value), breakMinutes = Number($d('break-duration').value), serviceMinutes = Number($d('service-time').value);
    if (!(shiftHours > 0 && shiftHours <= 16 && breakAfterHours >= 4 && breakAfterHours <= 5 && breakMinutes === 30 && serviceMinutes >= 0 && serviceMinutes <= 120)) {
      toast('Check the shift, rest interval, and service-time values.');
      return;
    }
    const button = $d('plan-delivery-btn');
    if (geofenceWatchId !== null) { navigator.geolocation?.clearWatch(geofenceWatchId); geofenceWatchId = null; }
    if (locationWatch !== null) { navigator.geolocation?.clearWatch(locationWatch); locationWatch = null; }
    lastTrackingPosition = null;
    button.disabled = true;
    button.querySelector('span').textContent = 'Optimizing stops…';
    $d('delivery-run-results').classList.add('hidden');
    removeDeliveryLayers();
    clearRouteResults();
    const ordered = orderStopsNearestNeighbor(deliveryStops);
    ordered.forEach((stop, index) => { stop.sequence = index + 1; stop.state = 'assigned'; stop.arrivalVerified = false; stop.otpSent = false; stop.otpVerified = false; stop.liveEtaAt = null; stop.proof = null; });
    const intervalMinutes = breakAfterHours * 60, shiftCapMinutes = shiftHours * 60;
    const timeline = [], assigned = [], pending = [], breaks = [];
    let cursor = { lat: start.lat, lon: start.lon }, elapsedMinutes = 0, driveSinceBreak = 0, distanceMeters = 0, totalDrivingMinutes = 0;
    try {
      for (let index = 0; index < ordered.length; index++) {
        const stop = ordered[index];
        const url = `/api/route?from=${cursor.lon},${cursor.lat}&to=${stop.lon},${stop.lat}`;
        const response = await fetch(url), data = await response.json();
        if (!response.ok || data.code !== 'Ok' || !data.routes?.length) throw Error(data.message || data.error || `Could not route to ${stop.name}.`);
        const route = chooseVehicleRoute(data.routes, profile);
        const legMinutes = route.duration / 60;
        const scheduledBreaks = breaksDuringLeg(route, legMinutes, driveSinceBreak, intervalMinutes, breakMinutes, elapsedMinutes);
        const etaMinutes = elapsedMinutes + scheduledBreaks.elapsedMinutes;
        const serviceEndMinutes = etaMinutes + serviceMinutes;
        if (serviceEndMinutes > shiftCapMinutes) {
          pending.push(...ordered.slice(index));
          ordered.slice(index).forEach((pendingStop) => { pendingStop.state = 'pending'; });
          break;
        }
        const warnings = profile.kind === 'sedan' ? [] : possibleNarrowRoads(route);
        const legDistance = route.distance;
        const accessFactor = Math.max(profile.width / 1.9, profile.height / 2.1, profile.weight / 3.5);
        const penaltyMinutes = warnings.length ? Math.round(warnings.length * Math.min(90, Math.max(0, (accessFactor - 1) * 30))) : 0;
        const planStop = Object.assign(stop, { route, etaMinutes, distanceMeters: legDistance, accessWarnings: warnings, accessPenaltyMinutes: penaltyMinutes });
        scheduledBreaks.breaks.forEach((breakEvent) => {
          const breakNode = { type: 'break', lat: breakEvent.point.lat, lon: breakEvent.point.lon, minutes: breakMinutes, atMinutes: breakEvent.atMinutes };
          breaks.push(breakNode);
          timeline.push(breakNode);
        });
        timeline.push(planStop);
        assigned.push(planStop);
        elapsedMinutes = serviceEndMinutes;
        driveSinceBreak = scheduledBreaks.driveSinceBreak;
        distanceMeters += legDistance;
        totalDrivingMinutes += legMinutes;
        cursor = { lat: stop.lat, lon: stop.lon };
      }
      deliveryPlan = { assigned, pending, breaks, timeline, elapsedMinutes, totalDrivingMinutes, distanceMeters, profile, intervalMinutes, breakMinutes, shiftCapMinutes };
      drawDeliveryPlan(deliveryPlan);
      renderRun(deliveryPlan);
      beginGeofenceWatch();
      if (pending.length) toast(`${pending.length} stop${pending.length === 1 ? '' : 's'} moved to Pending / Unassigned to stay within the ${shiftHours}-hour shift.`);
      if (profile.kind !== 'sedan') toast('Vehicle road-access checks are advisory; verify posted height and weight restrictions.');
    } catch (error) {
      toast(error.message);
    } finally {
      button.disabled = false;
      button.querySelector('span').textContent = 'Plan delivery run';
    }
  }
  $d('plan-delivery-btn').addEventListener('click', planDeliveryRun);

  function beginGeofenceWatch() {
    if (!navigator.geolocation || geofenceWatchId !== null || !deliveryPlan?.assigned.length) return;
    lastTrackingPosition = start ? { lat: start.lat, lon: start.lon } : null;
    lastTrackingRefresh = Date.now();
    geofenceWatchId = navigator.geolocation.watchPosition((position) => {
      if (position.coords.accuracy > 150) { setMapStatus(`GPS accuracy low (${Math.round(position.coords.accuracy)} m)`); return; }
      const current = { lat: position.coords.latitude, lon: position.coords.longitude };
      if (!inHyderabad(current.lat, current.lon)) { setMapStatus('Multi-stop GPS is outside Hyderabad'); return; }
      start = { ...current, label: 'Live current location' };
      $('map-from').textContent = 'Live current location';
      if (locateMarker) locateMarker.setLatLng([current.lat, current.lon]);
      else locateMarker = L.marker([current.lat, current.lon]).addTo(map).bindPopup('Live current position');
      const now = Date.now();
      if (lastTrackingPosition && haversineMeters(current, lastTrackingPosition) >= 150 && now - lastTrackingRefresh >= 60_000) {
        lastTrackingPosition = current; lastTrackingRefresh = now; refreshTrackedStopEta(current);
      }
      let changed = false;
      deliveryPlan.assigned.forEach((stop) => {
        if (stop.state === 'complete' || stop.arrivalVerified) return;
        const distance = haversineMeters(current, stop);
        if (distance <= 50) {
          stop.arrivalVerified = true;
          stop.arrivalDistanceMeters = distance;
          stop.arrivalVerifiedAt = new Date().toISOString();
          changed = true;
        }
      });
      if (changed) renderRun(deliveryPlan);
    }, () => {}, { enableHighAccuracy: true, maximumAge: 2000, timeout: 15000 });
  }

  async function sendDeliveryOtp(stopId) {
    const stop = deliveryPlan?.assigned.find((item) => item.id === stopId);
    if (!stop?.customerPhone) { toast('Add a customer phone number to this stop before sending an OTP.'); return; }
    try {
      const response = await fetch('/api/otp/send', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ phone: stop.customerPhone }) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw Error(data.error || (response.status === 404 ? 'Restart the Java server to enable delivery OTP.' : 'Could not send the customer OTP.'));
      stop.otpSent = true; stop.otpVerified = false;
      appendSmsLog(`OTP sent to ${stop.customerPhone} for Stop ${stop.sequence}.`);
      renderRun(deliveryPlan); toast(`Delivery OTP sent for Stop ${stop.sequence}.`);
    } catch (error) { toast(error.message); appendSmsLog(`OTP not sent for Stop ${stop.sequence}: ${error.message}`); }
  }

  async function verifyDeliveryOtp() {
    if (!activeStop?.customerPhone || !activeStop.otpSent) { toast('Send a customer OTP first.'); return; }
    const code = $d('pod-customer-code').value.trim();
    const button = $d('verify-delivery-otp'); button.disabled = true;
    try {
      const response = await fetch('/api/otp/check', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ phone: activeStop.customerPhone, code }) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.approved) throw Error(data.error || (response.status === 404 ? 'Restart the Java server to enable delivery OTP.' : 'Customer code is invalid or expired.'));
      activeStop.otpVerified = true; $d('delivery-otp-status').textContent = 'Customer phone verified. Proof of delivery can be saved.';
      renderRun(deliveryPlan); toast('Customer OTP verified.');
    } catch (error) { $d('delivery-otp-status').textContent = error.message; toast(error.message); }
    finally { button.disabled = false; }
  }
  $d('verify-delivery-otp').addEventListener('click', verifyDeliveryOtp);

  async function refreshTrackedStopEta(current) {
    const next = deliveryPlan?.assigned.find((stop) => stop.state !== 'complete');
    if (!next) return;
    const params = `from=${current.lon},${current.lat}&to=${next.lon},${next.lat}`;
    try {
      let response = await fetch(`/api/traffic-route?${params}`), seconds;
      if (response.ok) { const data = await response.json(); seconds = Math.min(...(data.routes || []).map((route) => googleDuration(route.duration))); }
      else if (response.status === 503 || response.status === 404) { response = await fetch(`/api/route?${params}`); const data = await response.json(); if (response.ok && data.routes?.length) seconds = Math.min(...data.routes.map((route) => route.duration)); }
      else throw Error('Traffic ETA refresh failed.');
      if (!(seconds > 0)) throw Error('No route ETA returned.');
      next.liveEtaAt = Date.now() + seconds * 1000; renderRun(deliveryPlan); setMapStatus('Live multi-stop ETA updated');
    } catch { setMapStatus('Multi-stop tracking · ETA refresh unavailable'); }
  }

  function checkArrival(stopId) {
    const stop = deliveryPlan?.assigned.find((item) => item.id === stopId);
    if (!stop) return;
    if (stop.customerPhone && !stop.otpSent) { toast('Send the delivery OTP before completing this stop.'); sendDeliveryOtp(stop.id); return; }
    if (!navigator.geolocation) { toast('Location access is required to verify delivery within 50 m.'); return; }
    navigator.geolocation.getCurrentPosition((position) => {
      const current = { lat: position.coords.latitude, lon: position.coords.longitude };
      const distance = haversineMeters(current, stop);
      if (distance > 50) { toast(`Arrival not verified: you are about ${Math.round(distance)} m away. Move within 50 m of Stop ${stop.sequence}.`); return; }
      arrivalFix = { ...current, distanceMeters: distance, verifiedAt: new Date().toISOString() };
      stop.arrivalVerified = true;
      stop.arrivalDistanceMeters = distance;
      stop.arrivalVerifiedAt = arrivalFix.verifiedAt;
      activeStop = stop;
      $d('delivery-otp-panel').classList.toggle('hidden', !stop.customerPhone);
      $d('pod-customer-code').value = '';
      $d('delivery-otp-status').textContent = stop.otpVerified ? 'Customer phone verified.' : 'Ask the customer for the code sent to their phone.';
      photoBase64 = null;
      photoMimeType = null;
      signaturePoints = [];
      signatureContext.clearRect(0, 0, signatureCanvas.width, signatureCanvas.height);
      $d('pod-photo').value = '';
      $d('pod-stop-name').textContent = `Stop ${stop.sequence}: ${stop.name} · Geofence verified (${Math.round(distance)} m)`;
      $d('pod-modal').classList.remove('hidden');
    }, () => toast('Allow precise location access to verify arrival within 50 m.'), { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
  }

  function canvasPoint(event) {
    const rect = signatureCanvas.getBoundingClientRect();
    return { x: (event.clientX - rect.left) * signatureCanvas.width / rect.width, y: (event.clientY - rect.top) * signatureCanvas.height / rect.height, nx: (event.clientX - rect.left) / rect.width, ny: (event.clientY - rect.top) / rect.height, t: Date.now() };
  }
  signatureCanvas.addEventListener('pointerdown', (event) => {
    signatureDrawing = true;
    signatureCanvas.setPointerCapture(event.pointerId);
    const point = canvasPoint(event);
    signaturePoints.push({ x: point.nx, y: point.ny, t: point.t });
    signatureContext.beginPath();
    signatureContext.moveTo(point.x, point.y);
  });
  signatureCanvas.addEventListener('pointermove', (event) => {
    if (!signatureDrawing) return;
    const point = canvasPoint(event);
    signatureContext.lineTo(point.x, point.y);
    signatureContext.stroke();
    signaturePoints.push({ x: point.nx, y: point.ny, t: point.t });
  });
  const stopSignature = () => { signatureDrawing = false; };
  signatureCanvas.addEventListener('pointerup', stopSignature);
  signatureCanvas.addEventListener('pointercancel', stopSignature);
  $d('clear-signature').addEventListener('click', () => { signaturePoints = []; signatureContext.clearRect(0, 0, signatureCanvas.width, signatureCanvas.height); });
  $d('pod-photo').addEventListener('change', () => {
    const file = $d('pod-photo').files?.[0];
    photoBase64 = null;
    photoMimeType = null;
    photoReading = false;
    if (!file) return;
    if (!file.type.startsWith('image/') || file.size > 4 * 1024 * 1024) {
      $d('pod-photo').value = '';
      toast('Choose an image file no larger than 4 MB.');
      return;
    }
    const reader = new FileReader();
    photoReading = true;
    reader.onload = () => { const encoded = String(reader.result || '').split(','); photoBase64 = encoded[1] || null; photoMimeType = file.type; photoReading = false; };
    reader.onerror = () => { photoReading = false; toast('Could not read that proof photo.'); };
    reader.readAsDataURL(file);
  });

  function closePodModal() {
    $d('pod-modal').classList.add('hidden');
    activeStop = null;
  }
  $d('pod-close').addEventListener('click', closePodModal);
  $d('pod-cancel').addEventListener('click', closePodModal);
  $d('pod-modal').addEventListener('click', (event) => { if (event.target === $d('pod-modal')) closePodModal(); });
  $d('logout-btn').addEventListener('click', () => {
    if (geofenceWatchId !== null) navigator.geolocation?.clearWatch(geofenceWatchId);
    geofenceWatchId = null;
  });

  function appendSmsLog(message) {
    const log = $d('delivery-sms-log');
    if (log.dataset.empty !== 'false') { log.innerHTML = ''; log.dataset.empty = 'false'; }
    const entry = document.createElement('p');
    entry.className = 'sms-log-entry';
    entry.textContent = `${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · ${message}`;
    log.prepend(entry);
  }
  async function notifyNextStop(completedStop, currentPosition) {
    const nextStop = deliveryPlan?.assigned.find((stop) => stop.sequence > completedStop.sequence && stop.state !== 'complete');
    if (!nextStop) { appendSmsLog(`Stop ${completedStop.sequence} completed. No next assigned stop is waiting.`); return; }
    if (!nextStop.customerPhone) { appendSmsLog(`No SMS sent for Stop ${nextStop.sequence}: add a customer phone number to that stop.`); return; }
    let minutes = Math.max(1, Math.round(nextStop.route.duration / 60));
    try {
      const query = `from=${currentPosition.lon},${currentPosition.lat}&to=${nextStop.lon},${nextStop.lat}`;
      let routeResponse = await fetch(`/api/traffic-route?${query}`), seconds;
      if (routeResponse.ok) { const data = await routeResponse.json(); seconds = Math.min(...(data.routes || []).map((route) => googleDuration(route.duration))); }
      else if (routeResponse.status === 503 || routeResponse.status === 404) { routeResponse = await fetch(`/api/route?${query}`); const data = await routeResponse.json(); if (routeResponse.ok && data.routes?.length) seconds = Math.min(...data.routes.map((route) => route.duration)); }
      if (seconds > 0) minutes = Math.max(1, Math.round(seconds / 60));
    } catch { /* Use the planned ETA and report the SMS outcome separately. */ }
    const message = `RouteWise: your delivery driver is about ${minutes} minutes away from Stop ${nextStop.sequence}.`;
    try {
      const response = await fetch('/api/sms/send', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ to: nextStop.customerPhone, message }) });
      const data = await response.json().catch(() => ({})); if (!response.ok) throw Error(data.error || (response.status === 404 ? 'Restart the Java server to enable customer SMS.' : 'SMS provider rejected the message.'));
      appendSmsLog(`ETA SMS sent to ${nextStop.customerPhone}: driver is about ${minutes} min away.`);
    } catch (error) { appendSmsLog(`ETA SMS not sent to ${nextStop.customerPhone}: ${error.message}`); }
  }
  $d('pod-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!activeStop || !arrivalFix) return;
    if (activeStop.customerPhone && !activeStop.otpVerified) { toast('Verify the customer SMS OTP before saving proof of delivery.'); return; }
    if (photoReading) { toast('Wait for the proof photo to finish loading, then save again.'); return; }
    if (!photoBase64 && !signaturePoints.length) { toast('Attach a delivery photo or capture a customer signature.'); return; }
    activeStop.state = 'complete';
    activeStop.proof = {
      photoBase64,
      photoMimeType,
      signaturePoints: [...signaturePoints],
      signaturePngBase64: signaturePoints.length ? signatureCanvas.toDataURL('image/png').split(',')[1] : null,
      completedAt: new Date().toISOString(),
      geofence: { radiusMeters: 50, verifiedDistanceMeters: arrivalFix.distanceMeters, verifiedAt: arrivalFix.verifiedAt, driverLat: arrivalFix.lat, driverLon: arrivalFix.lon }
    };
    const completedStop = activeStop, currentPosition = { lat: arrivalFix.lat, lon: arrivalFix.lon };
    closePodModal();
    renderRun(deliveryPlan);
    if (deliveryPlan.assigned.every((stop) => stop.state === 'complete') && geofenceWatchId !== null) { navigator.geolocation?.clearWatch(geofenceWatchId); geofenceWatchId = null; }
    toast(`Stop ${completedStop.sequence} completed with proof of delivery.`);
    await notifyNextStop(completedStop, currentPosition);
  });
})();
