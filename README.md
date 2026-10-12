# RouteWise — Delivery Route Optimizer

A small Java web application for comparing up to four mapped road routes within Hyderabad from a user's current location to a searched destination. It requests up to three alternatives from OSRM (in addition to its primary route), ranks the displayed choices by travel time and distance, and estimates motorbike fuel cost using the rider's bike and entered mileage.

## Requirements

- Java 17 or newer
- Internet access for OpenStreetMap map tiles, Photon place search, and OSRM routes

## Run

From this folder:

```powershell
java src/main/java/app/RouteOptimizerServer.java
```

Then open http://localhost:8080. Set a different port with `$env:PORT=8081` before running. Do not double-click `index.html`; direct `file://` pages cannot provide the HTTP referer needed by the map tiles and cannot call the Java API correctly.

On Windows, you can instead double-click `run-routewise.bat`. It starts the Java server and opens the app in your browser.

Create an account with your name, email, and password, or log in with the email and password saved in this browser. Account profiles are local demo data; this project has no server-side user database. Then allow location access in the browser, enter your bike and its typical mileage, search for a destination in Hyderabad, and choose a route to highlight it. Place search text is sent to Photon; route start/destination coordinates are sent to OSRM through the Java server. Bike name, mileage, and fuel price are kept locally in the browser. Fuel cost is estimated as distance ÷ entered mileage × petrol price, and should be treated as an estimate.

## Routing and algorithms

The browser gets the device location through the Geolocation API and uses Photon place suggestions after the first typed character, limited to Hyderabad. The Java server accepts coordinates inside its Hyderabad bounding box and forwards them to OSRM's road routing service requesting up to three alternatives plus the primary route. If OSRM returns fewer than four, the browser tries additional real routes through nearby Hyderabad waypoints and removes duplicate geometries. The map service can still return fewer routes when the road network has no more distinct corridors.

## Delivery run demo

Open **Multi-stop delivery run** to add Hyderabad delivery stops. A nearest-neighbour ordering heuristic sequences them, OSRM road legs provide estimated time and distance, configurable 4–5-hour driving intervals insert simulated 30-minute break nodes, and stops exceeding the configured shift cap move to **Pending / Unassigned**. Sedan, Box Truck, and Semi-Trailer profiles have editable example dimensions; route names containing `lane`, `gali`, or `service road` receive a size-based planning penalty for larger vehicles. The public OSRM driving profile does not supply reliable bridge-clearance or legal weight restriction data, so this is not a legally safe truck-routing check.

For proof of delivery, a driver must be within the 50 m Haversine geofence and attach a photo or capture a signature. The completed stop object holds Base64 proof, signature points, timestamp, and geofence verification. Completing a stop refreshes the next-stop ETA and sends an SMS when Twilio Messaging is configured. Delivery run state and proof remain in page memory for this demo and are not persisted to a server.

OpenStreetMap's public services have usage policies and are intended for reasonable demo traffic. For a production delivery system, use a hosted routing/geocoding provider or run your own services, and configure appropriate attribution, rate limits, caching, and privacy notices.

## Shared Google Maps destinations and PWA

RouteWise now reads shared destinations from `/?url=<encoded-map-link>` (also `shared_url`, `text`, and `link` query names). It recognizes Google Maps coordinate and place URL forms, fills the existing destination field, marks coordinates on the map, and tries to resolve Google Maps short links through the Java endpoint. The resolver only starts with HTTPS `maps.app.goo.gl`, `goo.gl`, or `g.co` URLs, follows a limited number of redirects, and rejects redirects outside Google domains. Short-link requests need the server's outbound internet access. A failed/unsupported link leaves the normal manual destination field available.

The web manifest adds installability metadata and a GET share target. On supported browsers, install RouteWise and select it from the system share sheet to send a Maps link. This is **not** a claim that an ordinary website can register itself to open links tapped in WhatsApp/SMS. The app needs to be hosted on HTTPS for PWA install/share support and geolocation outside localhost. The current localhost demo can be tested with `http://localhost:8080/?url=...`.

There is no native Android wrapper, production domain, Android package name, signing certificate, or domain ownership configuration in this repository. Therefore Android App Links and verified interception of links from other apps are not configured. To enable that, build/sign a native Android wrapper with HTTPS intent filters for `https://www.google.com/maps/*`, `https://maps.google.com/*`, and any owned short-link domain; host `/.well-known/assetlinks.json` containing the real package name and SHA-256 signing certificate fingerprint; and have the wrapper forward the incoming URL into the web app. A PWA share target alone does not provide verified App Links.

## Location, route estimates, and limitations

The origin uses browser geolocation. Selecting **Select and begin navigation** starts `watchPosition`; inaccurate fixes over 150 m are not used, and the app refreshes routes no more often than once per minute after movement exceeds 150 m. This requires user permission and a secure context (HTTPS, or localhost). Denial/unavailable GPS leaves manual map-origin selection available. The app provides provider route instructions, but does not implement turn-by-turn voice guidance or map-matching.

When `GOOGLE_MAPS_API_KEY` is configured, the Java server calls Google Routes API with `TWO_WHEELER` and `TRAFFIC_AWARE`, and returns its real-time traffic duration and distinct alternatives. The secret stays on the server. Without the key, RouteWise falls back to OSRM and marks the results as standard estimates with no live traffic. Either provider may return fewer than four distinct options. Fastest, shortest, and lowest-fuel labels are calculated from returned routes. Fuel uses road distance ÷ configured km/L × configured rupees/L. Neither current provider supplies toll estimates to this interface, so tolls are marked unavailable. Traffic refreshes during a selected route are rate-limited to once per minute.

### Enable live traffic

1. Create a Google Cloud project, enable the Routes API, configure billing, and create an API key restricted to the Routes API. For a server-side key, apply suitable server/IP restrictions where available.
2. Set the key in the same PowerShell session before starting RouteWise:

   ```powershell
   $env:GOOGLE_MAPS_API_KEY="YOUR_SERVER_SIDE_KEY"
   java src/main/java/app/RouteOptimizerServer.java
   ```

3. The results source label should read **Google Routes · live traffic-aware estimates**. If the variable is unset, the app uses OSRM and labels that fallback.

The Google Routes API request uses traffic-aware routing and returns provider-computed alternatives when available. See [Google's Compute Routes documentation](https://developers.google.com/maps/documentation/routes/compute_route_directions) and [routing preferences](https://developers.google.com/maps/documentation/routes/reference/rest/v2/RoutingPreference). Provider access, quotas, billing, and coverage depend on the Google Cloud project and region. No live API call can succeed until a valid key is configured and the server can reach Google.

## Delivery SMS, SOS, and multi-stop tracking

SMS flows use Twilio Verify for per-stop customer OTP checks. Twilio Messaging sends SOS alerts to the server-configured trusted contacts and sends an ETA text to the next stop's customer after a delivery is completed. The server never generates or exposes OTP values itself. Configure these variables in PowerShell before starting Java:

```powershell
$env:TWILIO_ACCOUNT_SID="AC..."
$env:TWILIO_AUTH_TOKEN="..."
$env:TWILIO_VERIFY_SERVICE_SID="VA..."
$env:TWILIO_FROM_NUMBER="+1..."
$env:SOS_RECIPIENTS="+91...,+1..."
java src/main/java/app/RouteOptimizerServer.java
```

Create a Twilio Verify Service and a Messaging sender, use E.164 phone numbers, and keep credentials only in the server environment. A Twilio trial account may restrict recipients to verified numbers. Account sign-in uses a local demo profile stored in browser local storage and is not server-side authentication. Keep the Java server on localhost or behind a properly authenticated production backend before exposing SMS endpoints publicly. SMS sending and verification require a configured account and may incur provider charges. Without configuration, OTP/SOS/ETA actions show an explicit provider-setup error and do not pretend a message was sent.

During a multi-stop run, driver GPS tracking refreshes the next assigned stop's ETA after at least 150 m movement and no more than once per minute. If that stop has a customer phone number, the driver must send and verify its customer OTP before saving proof of delivery. A successful stop completion sends the next customer's ETA by SMS when messaging is configured.

## Verification commands

From the project folder:

```powershell
javac src/main/java/app/RouteOptimizerServer.java
java src/main/java/app/RouteOptimizerServer.java
```

Open `http://localhost:8080/?url=https%3A%2F%2Fwww.google.com%2Fmaps%2Fsearch%2F%3Fapi%3D1%26query%3D17.385%2C78.4867`. After the app loads, sign in if prompted, grant location permission, find routes, compare the four labels/metrics, and select a route to start GPS tracking. Invalid link fallback can be checked with `http://localhost:8080/?url=not-a-map-link`. Provider requests need internet access, and the browser flow needs a real GPS-capable device for live-position verification.
