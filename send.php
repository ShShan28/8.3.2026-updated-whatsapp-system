<?php
// 1. SILENCE SCREEN ERRORS
ini_set('display_errors', 0);
error_reporting(E_ALL);

// 2. PREPARE TO CATCH CRASHES
register_shutdown_function(function() {
    $error = error_get_last();
    if ($error && ($error['type'] === E_ERROR || $error['type'] === E_PARSE || $error['type'] === E_CORE_ERROR)) {
        ob_clean(); 
        http_response_code(500);
        echo json_encode(["error" => "PHP CRASH: " . $error['message'] . " on line " . $error['line']]);
        exit;
    }
});

ob_start();

header("Access-Control-Allow-Origin: *");
header("Content-Type: application/json");

try {
    // 3. READ INPUT
    $raw = file_get_contents("php://input");
    if (!$raw) throw new Exception("No input received");
    
    $data = json_decode($raw, true);
    if (!$data) throw new Exception("Invalid JSON received");

    // 4. CREDENTIALS
    $id = trim($data["instance_id"] ?? "");
    $token = trim($data["token"] ?? "");
    $to = trim($data["to"] ?? "");
    $body = trim($data["body"] ?? "");
    $b64 = trim($data["base64"] ?? "");
    $fname = trim($data["filename"] ?? "");

    if (!$id || !$token) throw new Exception("Missing Instance ID or Token");

    $base = (strpos($id, "http") === 0) ? $id : "https://api.ultramsg.com/$id";
    $base = rtrim($base, "/") . "/";
    $url = $base . "messages/chat";
    $payload = ["token" => $token, "to" => $to, "body" => $body];

    // 5. FILE HANDLING (Smart Bridge)
    if ($b64 && $fname) {
        $mb = (strlen($b64) * 0.75) / 1048576;
        
        // Large File Logic (>9MB)
        if ($mb > 9.0) {
            $tmp_dir = sys_get_temp_dir();
            $tmp_file = tempnam($tmp_dir, 'wa_');
            $new_path = $tmp_file . '_' . $fname; 
            rename($tmp_file, $new_path);
            
            file_put_contents($new_path, base64_decode($b64));
            
            $ch = curl_init($base . "media/upload");
            curl_setopt($ch, CURLOPT_RETURNTRANSFER, 1);
            curl_setopt($ch, CURLOPT_POST, 1);
            curl_setopt($ch, CURLOPT_POSTFIELDS, ["token" => $token, "file" => new CURLFile($new_path, "application/pdf", $fname)]);
            curl_setopt($ch, CURLOPT_SSL_VERIFYHOST, 0);
            curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, 0);
            
            $up_raw = curl_exec($ch);
            $up_err = curl_error($ch);
            curl_close($ch);
            @unlink($new_path);

            if ($up_err) throw new Exception("Upload Connection Failed: $up_err");
            
            $up_json = json_decode($up_raw, true);
            
            // FIX: Check for 'url' OR 'success' (UltraMsg uses both)
            $file_link = $up_json["url"] ?? $up_json["success"] ?? null;

            if (!$file_link) {
                throw new Exception("UltraMsg Upload Rejected: " . strip_tags($up_raw));
            }
            
            $url = $base . "messages/document";
            $payload = ["token" => $token, "to" => $to, "document" => $file_link, "filename" => $fname, "caption" => $body];
        
        } else {
            // Standard Mode (<9MB)
            $url = $base . "messages/document";
            $payload = ["token" => $token, "to" => $to, "document" => $b64, "filename" => $fname, "caption" => $body];
        }
    }

    // 6. FINAL SEND
    $ch = curl_init($url);
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, 1);
    curl_setopt($ch, CURLOPT_POST, 1);
    curl_setopt($ch, CURLOPT_POSTFIELDS, http_build_query($payload));
    curl_setopt($ch, CURLOPT_SSL_VERIFYHOST, 0);
    curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, 0);
    
    $res = curl_exec($ch);
    $err = curl_error($ch);
    curl_close($ch);

    if ($err) throw new Exception("Send Connection Failed: $err");
    
    ob_end_clean();
    echo $res;

} catch (Exception $e) {
    ob_end_clean();
    echo json_encode(["error" => $e->getMessage()]);
}
?>