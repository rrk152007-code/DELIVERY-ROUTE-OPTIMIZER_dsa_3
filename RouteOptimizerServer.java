package app;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.Base64;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/** Lightweight Java web server and proxy for OpenStreetMap geocoding/routing. */
public final class RouteOptimizerServer {
    private static final HttpClient CLIENT = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(8)).followRedirects(HttpClient.Redirect.NORMAL).build();
    private static final HttpClient LINK_CLIENT = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(8)).followRedirects(HttpClient.Redirect.NEVER).build();
    private static final Path STATIC = Path.of("src/main/resources/static");
    private static final Map<String, Long> SMS_COOLDOWNS = new ConcurrentHashMap<>();

    public static void main(String[] args) throws IOException {
        int port = Integer.parseInt(System.getenv().getOrDefault("PORT", "8080"));
        HttpServer server = HttpServer.create(new InetSocketAddress(port), 0);
        server.createContext("/api/geocode", RouteOptimizerServer::geocode);
        server.createContext("/api/route", RouteOptimizerServer::route);
        server.createContext("/api/traffic-route", RouteOptimizerServer::trafficRoute);
        server.createContext("/api/otp/send", exchange -> otp(exchange, false));
        server.createContext("/api/otp/check", exchange -> otp(exchange, true));
        server.createContext("/api/sms/send", RouteOptimizerServer::sendSms);
        server.createContext("/api/sos", RouteOptimizerServer::sos);
        server.createContext("/api/resolve-map-link", RouteOptimizerServer::resolveMapLink);
        server.createContext("/", RouteOptimizerServer::staticFile);
        server.setExecutor(java.util.concurrent.Executors.newFixedThreadPool(12));
        server.start();
        System.out.println("RouteWise is running at http://localhost:" + port);
    }

    private static void otp(HttpExchange exchange, boolean check) throws IOException {
        if (!requirePost(exchange)) return;
        Map<String, String> form = form(exchange);
        String phone = form.getOrDefault("phone", "").trim();
        String code = form.getOrDefault("code", "").trim();
        String account = System.getenv().getOrDefault("TWILIO_ACCOUNT_SID", "").trim();
        String token = System.getenv().getOrDefault("TWILIO_AUTH_TOKEN", "").trim();
        String service = System.getenv().getOrDefault("TWILIO_VERIFY_SERVICE_SID", "").trim();
        if (account.isEmpty() || token.isEmpty() || service.isEmpty()) { send(exchange, 503, "{\"error\":\"SMS verification is not configured. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_VERIFY_SERVICE_SID.\"}", "application/json; charset=utf-8"); return; }
        if (!phone.matches("\\+[1-9][0-9]{7,14}")) { send(exchange, 400, "{\"error\":\"Enter a phone number in international E.164 format, such as +14155550123.\"}", "application/json; charset=utf-8"); return; }
        if (check && !code.matches("[0-9]{4,10}")) { send(exchange, 400, "{\"error\":\"Enter the 4 to 10 digit SMS code.\"}", "application/json; charset=utf-8"); return; }
        if (!check && !allowSms("otp:" + phone, 30_000)) { send(exchange, 429, "{\"error\":\"Wait 30 seconds before requesting another code.\"}", "application/json; charset=utf-8"); return; }
        String path = "https://verify.twilio.com/v2/Services/" + service + (check ? "/VerificationCheck" : "/Verifications");
        String body = "To=" + enc(phone) + (check ? "&Code=" + enc(code) : "&Channel=sms");
        try {
            HttpResponse<String> response = twilioPost(path, body, account, token);
            if (response.statusCode() < 200 || response.statusCode() >= 300) { send(exchange, 502, "{\"error\":\"The SMS provider rejected the verification request. Check the Twilio service and destination number.\"}", "application/json; charset=utf-8"); return; }
            if (!check) { send(exchange, 200, "{\"sent\":true}", "application/json; charset=utf-8"); return; }
            boolean approved = response.body().matches("(?s).*\\\"status\\\"\\s*:\\s*\\\"approved\\\".*");
            send(exchange, 200, "{\"approved\":" + approved + "}", "application/json; charset=utf-8");
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt(); send(exchange, 503, "{\"error\":\"SMS verification was interrupted. Try again.\"}", "application/json; charset=utf-8");
        } catch (Exception e) {
            send(exchange, 502, "{\"error\":\"Could not reach the SMS verification provider. Check server internet access.\"}", "application/json; charset=utf-8");
        }
    }

    private static void sendSms(HttpExchange exchange) throws IOException {
        if (!requirePost(exchange)) return;
        Map<String, String> form = form(exchange);
        String to = form.getOrDefault("to", "").trim(), message = form.getOrDefault("message", "").trim();
        String account = System.getenv().getOrDefault("TWILIO_ACCOUNT_SID", "").trim();
        String token = System.getenv().getOrDefault("TWILIO_AUTH_TOKEN", "").trim();
        String from = System.getenv().getOrDefault("TWILIO_FROM_NUMBER", "").trim();
        if (account.isEmpty() || token.isEmpty() || from.isEmpty()) { send(exchange, 503, "{\"error\":\"SMS delivery is not configured. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_FROM_NUMBER.\"}", "application/json; charset=utf-8"); return; }
        if (!to.matches("\\+[1-9][0-9]{7,14}") || message.isEmpty() || message.length() > 500) { send(exchange, 400, "{\"error\":\"A valid E.164 recipient and message up to 500 characters are required.\"}", "application/json; charset=utf-8"); return; }
        if (!allowSms("message:" + to, 10_000)) { send(exchange, 429, "{\"error\":\"Wait before sending another text to this number.\"}", "application/json; charset=utf-8"); return; }
        try {
            HttpResponse<String> response = twilioPost("https://api.twilio.com/2010-04-01/Accounts/" + account + "/Messages.json", "From=" + enc(from) + "&To=" + enc(to) + "&Body=" + enc(message), account, token);
            if (response.statusCode() < 200 || response.statusCode() >= 300) { send(exchange, 502, "{\"error\":\"The SMS provider could not deliver this message. Check the sender and recipient configuration.\"}", "application/json; charset=utf-8"); return; }
            send(exchange, 200, "{\"sent\":true}", "application/json; charset=utf-8");
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt(); send(exchange, 503, "{\"error\":\"SMS delivery was interrupted. Try again.\"}", "application/json; charset=utf-8");
        } catch (Exception e) {
            send(exchange, 502, "{\"error\":\"Could not reach the SMS provider. Check server internet access.\"}", "application/json; charset=utf-8");
        }
    }

    private static void sos(HttpExchange exchange) throws IOException {
        if (!requirePost(exchange)) return;
        String recipients = System.getenv().getOrDefault("SOS_RECIPIENTS", "").trim();
        if (recipients.isEmpty()) { send(exchange, 503, "{\"error\":\"SOS SMS is not configured. Set SOS_RECIPIENTS to trusted contacts in E.164 format.\"}", "application/json; charset=utf-8"); return; }
        Map<String, String> form = form(exchange);
        String name = form.getOrDefault("name", "RouteWise rider").replaceAll("[\\r\\n]", " ").trim();
        String lat = form.getOrDefault("lat", ""), lon = form.getOrDefault("lon", "");
        if (!lat.matches("-?\\d{1,2}\\.\\d+") || !lon.matches("-?\\d{1,3}\\.\\d+") || !validPoint(lon + "," + lat)) { send(exchange, 400, "{\"error\":\"A valid current Hyderabad location is required to send SOS.\"}", "application/json; charset=utf-8"); return; }
        if (!allowSms("sos", 120_000)) { send(exchange, 429, "{\"error\":\"An SOS was sent recently. Please wait before sending another alert.\"}", "application/json; charset=utf-8"); return; }
        String account = System.getenv().getOrDefault("TWILIO_ACCOUNT_SID", "").trim(), token = System.getenv().getOrDefault("TWILIO_AUTH_TOKEN", "").trim(), from = System.getenv().getOrDefault("TWILIO_FROM_NUMBER", "").trim();
        if (account.isEmpty() || token.isEmpty() || from.isEmpty()) { send(exchange, 503, "{\"error\":\"SOS SMS needs TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_FROM_NUMBER.\"}", "application/json; charset=utf-8"); return; }
        String text = "ROUTEWISE SOS: " + (name.isEmpty() ? "A rider" : name) + " needs help. Current location: https://maps.google.com/?q=" + lat + "," + lon;
        int sent = 0;
        try {
            for (String recipient : recipients.split(",")) {
                String to = recipient.trim();
                if (!to.matches("\\+[1-9][0-9]{7,14}")) continue;
                HttpResponse<String> response = twilioPost("https://api.twilio.com/2010-04-01/Accounts/" + account + "/Messages.json", "From=" + enc(from) + "&To=" + enc(to) + "&Body=" + enc(text), account, token);
                if (response.statusCode() >= 200 && response.statusCode() < 300) sent++;
            }
            if (sent == 0) { send(exchange, 502, "{\"error\":\"No SOS message was accepted. Check configured contacts and Twilio sender.\"}", "application/json; charset=utf-8"); return; }
            send(exchange, 200, "{\"sent\":true,\"recipients\":" + sent + "}", "application/json; charset=utf-8");
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt(); send(exchange, 503, "{\"error\":\"SOS SMS was interrupted. Call emergency services if this is urgent.\"}", "application/json; charset=utf-8");
        } catch (Exception e) {
            send(exchange, 502, "{\"error\":\"SOS SMS could not reach the provider. Call emergency services if this is urgent.\"}", "application/json; charset=utf-8");
        }
    }

    private static boolean requirePost(HttpExchange exchange) throws IOException {
        if (!"POST".equalsIgnoreCase(exchange.getRequestMethod())) { send(exchange, 405, "{\"error\":\"POST required.\"}", "application/json; charset=utf-8"); return false; }
        String origin = exchange.getRequestHeaders().getFirst("Origin"), host = exchange.getRequestHeaders().getFirst("Host");
        if (origin != null && host != null) {
            try { if (!host.equalsIgnoreCase(URI.create(origin).getAuthority())) { send(exchange, 403, "{\"error\":\"Cross-origin SMS requests are not allowed.\"}", "application/json; charset=utf-8"); return false; } }
            catch (IllegalArgumentException e) { send(exchange, 403, "{\"error\":\"Invalid request origin.\"}", "application/json; charset=utf-8"); return false; }
        }
        return true;
    }
    private static Map<String, String> form(HttpExchange exchange) throws IOException {
        String raw = new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
        java.util.HashMap<String, String> values = new java.util.HashMap<>();
        for (String part : raw.split("&")) { String[] pair = part.split("=", 2); if (pair.length == 2) values.put(java.net.URLDecoder.decode(pair[0], StandardCharsets.UTF_8), java.net.URLDecoder.decode(pair[1], StandardCharsets.UTF_8)); }
        return values;
    }
    private static HttpResponse<String> twilioPost(String url, String body, String account, String token) throws IOException, InterruptedException {
        String auth = Base64.getEncoder().encodeToString((account + ":" + token).getBytes(StandardCharsets.UTF_8));
        HttpRequest request = HttpRequest.newBuilder(URI.create(url)).timeout(Duration.ofSeconds(20)).header("Authorization", "Basic " + auth).header("Content-Type", "application/x-www-form-urlencoded").POST(HttpRequest.BodyPublishers.ofString(body)).build();
        return CLIENT.send(request, HttpResponse.BodyHandlers.ofString());
    }
    private static boolean allowSms(String key, long cooldownMillis) {
        long now = System.currentTimeMillis(); Long previous = SMS_COOLDOWNS.putIfAbsent(key, now);
        if (previous == null) return true;
        if (now - previous >= cooldownMillis && SMS_COOLDOWNS.replace(key, previous, now)) return true;
        return false;
    }

    /** Resolve only known Google Maps short-link hosts, following HTTPS redirects with a strict hop/host policy. */
    private static void resolveMapLink(HttpExchange exchange) throws IOException {
        String value = queryParam(exchange.getRequestURI().getRawQuery(), "url");
        try {
            URI current = URI.create(value);
            if (!isShortMapHost(current)) { send(exchange, 400, "{\"error\":\"Only Google Maps short links can be resolved.\"}", "application/json; charset=utf-8"); return; }
            for (int i = 0; i < 6; i++) {
                HttpRequest request = HttpRequest.newBuilder(current).timeout(Duration.ofSeconds(10)).header("User-Agent", "RouteWise/1.0").GET().build();
                HttpResponse<Void> response = LINK_CLIENT.send(request, HttpResponse.BodyHandlers.discarding());
                if (response.statusCode() >= 300 && response.statusCode() < 400 && response.headers().firstValue("location").isPresent()) {
                    URI next = current.resolve(response.headers().firstValue("location").get());
                    if (!"https".equalsIgnoreCase(next.getScheme()) || !isGoogleMapsHost(next)) throw new IllegalArgumentException("Short link redirected outside Google Maps.");
                    current = next; continue;
                }
                send(exchange, 200, "{\"url\":\"" + jsonEscape(current.toString()) + "\"}", "application/json; charset=utf-8"); return;
            }
            throw new IllegalArgumentException("Too many redirects while resolving this link.");
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt(); send(exchange, 503, "{\"error\":\"Map link resolution was interrupted.\"}", "application/json; charset=utf-8");
        } catch (Exception e) {
            send(exchange, 400, "{\"error\":\"This Google Maps short link could not be resolved safely. You can enter the destination manually.\"}", "application/json; charset=utf-8");
        }
    }
    private static boolean isShortMapHost(URI uri) {
        String host = uri.getHost();
        return "https".equalsIgnoreCase(uri.getScheme()) && host != null && (host.equalsIgnoreCase("maps.app.goo.gl") || host.equalsIgnoreCase("goo.gl") || host.equalsIgnoreCase("g.co"));
    }
    private static boolean isGoogleMapsHost(URI uri) {
        String host = uri.getHost();
        return host != null && (host.equalsIgnoreCase("google.com") || host.endsWith(".google.com") || host.equalsIgnoreCase("goo.gl") || host.endsWith(".goo.gl"));
    }
    private static String jsonEscape(String value) { return value.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n").replace("\r", "\\r"); }

    private static void geocode(HttpExchange exchange) throws IOException {
        String query = queryParam(exchange.getRequestURI().getRawQuery(), "q");
        if (query.isBlank()) { send(exchange, 400, "{\"error\":\"Enter a destination to search.\"}", "application/json"); return; }
        proxy(exchange, "https://photon.komoot.io/api/?limit=8&lang=en&lat=17.385&lon=78.4867&zoom=12&bbox=78.20,17.10,78.80,17.65&q=" + enc(query), "Place search");
    }

    private static void route(HttpExchange exchange) throws IOException {
        String from = queryParam(exchange.getRequestURI().getRawQuery(), "from");
        String to = queryParam(exchange.getRequestURI().getRawQuery(), "to");
        String via = queryParam(exchange.getRequestURI().getRawQuery(), "via");
        if (!validPoint(from) || !validPoint(to) || (!via.isBlank() && !validPoint(via))) { send(exchange, 400, "{\"error\":\"Valid Hyderabad start, waypoint, and destination coordinates are required.\"}", "application/json; charset=utf-8"); return; }
        // OSRM allows up to three alternatives; extra requests may route via distinct Hyderabad corridors.
        String coordinates = from + (via.isBlank() ? "" : ";" + via) + ";" + to;
        String alternatives = via.isBlank() ? "3" : "false";
        String url = "https://router.project-osrm.org/route/v1/driving/" + coordinates + "?alternatives=" + alternatives + "&steps=true&geometries=geojson&overview=full";
        proxy(exchange, url, "Route planning");
    }

    /** Google Routes API proxy; the API key stays on the server and is never sent to the browser. */
    private static void trafficRoute(HttpExchange exchange) throws IOException {
        String from = queryParam(exchange.getRequestURI().getRawQuery(), "from");
        String to = queryParam(exchange.getRequestURI().getRawQuery(), "to");
        String apiKey = System.getenv().getOrDefault("GOOGLE_MAPS_API_KEY", "").trim();
        if (apiKey.isEmpty()) { send(exchange, 503, "{\"error\":\"Live traffic is not configured. Add GOOGLE_MAPS_API_KEY to the server environment.\"}", "application/json; charset=utf-8"); return; }
        if (!validPoint(from) || !validPoint(to)) { send(exchange, 400, "{\"error\":\"Valid Hyderabad origin and destination coordinates are required.\"}", "application/json; charset=utf-8"); return; }
        String[] a = from.split(","), b = to.split(",");
        String body = "{\"origin\":{\"location\":{\"latLng\":{\"latitude\":" + a[1] + ",\"longitude\":" + a[0] + "}}}," +
                "\"destination\":{\"location\":{\"latLng\":{\"latitude\":" + b[1] + ",\"longitude\":" + b[0] + "}}}," +
                "\"travelMode\":\"TWO_WHEELER\",\"routingPreference\":\"TRAFFIC_AWARE\",\"computeAlternativeRoutes\":true," +
                "\"routeModifiers\":{\"avoidTolls\":false,\"avoidHighways\":false,\"avoidFerries\":true},\"languageCode\":\"en-IN\",\"units\":\"METRIC\"}";
        try {
            HttpRequest request = HttpRequest.newBuilder(URI.create("https://routes.googleapis.com/directions/v2:computeRoutes"))
                    .timeout(Duration.ofSeconds(25)).header("Content-Type", "application/json")
                    .header("X-Goog-Api-Key", apiKey)
                    .header("X-Goog-FieldMask", "routes.distanceMeters,routes.duration,routes.staticDuration,routes.polyline.encodedPolyline,routes.legs.steps.distanceMeters,routes.legs.steps.staticDuration,routes.legs.steps.navigationInstruction.instructions")
                    .POST(HttpRequest.BodyPublishers.ofString(body)).build();
            HttpResponse<String> response = CLIENT.send(request, HttpResponse.BodyHandlers.ofString());
            send(exchange, response.statusCode(), response.body(), "application/json; charset=utf-8");
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt(); send(exchange, 503, "{\"error\":\"Live traffic request was interrupted. Try again.\"}", "application/json; charset=utf-8");
        } catch (Exception e) {
            System.err.println("Google Routes request failed: " + e.getClass().getSimpleName() + ": " + e.getMessage());
            send(exchange, 502, "{\"error\":\"Google Routes could not be reached. Check server internet access and API configuration.\"}", "application/json; charset=utf-8");
        }
    }

    private static boolean validPoint(String point) {
        if (!point.matches("-?\\d{1,3}(\\.\\d+)?,-?\\d{1,2}(\\.\\d+)?")) return false;
        String[] values = point.split(",");
        double lon = Double.parseDouble(values[0]), lat = Double.parseDouble(values[1]);
        return lon >= 78.20 && lon <= 78.80 && lat >= 17.10 && lat <= 17.65;
    }

    private static void proxy(HttpExchange exchange, String url, String serviceName) throws IOException {
        try {
            HttpRequest request = HttpRequest.newBuilder(URI.create(url)).timeout(Duration.ofSeconds(25))
                    .header("User-Agent", "RouteWiseStudentProject/1.0 (route planning demo)")
                    .header("Accept", "application/json").GET().build();
            HttpResponse<String> response = CLIENT.send(request, HttpResponse.BodyHandlers.ofString());
            send(exchange, response.statusCode(), response.body(), "application/json; charset=utf-8");
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt(); send(exchange, 503, "{\"error\":\"" + serviceName + " was interrupted. Try again.\"}", "application/json; charset=utf-8");
        } catch (Exception e) {
            System.err.println(serviceName + " request failed: " + e.getClass().getSimpleName() + ": " + e.getMessage());
            send(exchange, 502, "{\"error\":\"" + serviceName + " cannot reach its map provider. Check this computer's internet connection and try again.\"}", "application/json; charset=utf-8");
        }
    }

    private static void staticFile(HttpExchange exchange) throws IOException {
        String path = exchange.getRequestURI().getPath();
        if (path.equals("/")) path = "/index.html";
        Path file = STATIC.resolve(path.substring(1)).normalize();
        if (!file.startsWith(STATIC.normalize()) || !Files.isRegularFile(file)) { send(exchange, 404, "Not found", "text/plain; charset=utf-8"); return; }
        String type = file.toString().endsWith(".css") ? "text/css; charset=utf-8" : file.toString().endsWith(".js") ? "text/javascript; charset=utf-8" : file.toString().endsWith(".webmanifest") ? "application/manifest+json; charset=utf-8" : "text/html; charset=utf-8";
        send(exchange, 200, Files.readString(file), type);
    }

    private static String queryParam(String raw, String key) {
        if (raw == null) return "";
        for (String part : raw.split("&")) {
            String[] pair = part.split("=", 2);
            if (pair.length == 2 && pair[0].equals(key)) return java.net.URLDecoder.decode(pair[1], StandardCharsets.UTF_8);
        }
        return "";
    }
    private static String enc(String value) { return URLEncoder.encode(value, StandardCharsets.UTF_8); }
    private static void send(HttpExchange exchange, int status, String body, String type) throws IOException {
        exchange.getResponseHeaders().set("Content-Type", type);
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        exchange.sendResponseHeaders(status, bytes.length);
        try (var out = exchange.getResponseBody()) { out.write(bytes); }
    }
}
