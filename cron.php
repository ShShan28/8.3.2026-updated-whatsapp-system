<?php
header('Content-Type: application/json');

if(!is_dir('logs')) mkdir('logs', 0777, true);

$instance_id = 'instance153584';
$token = 'vman605et11n5ov8';
$schedulesFile = __DIR__.'/logs/schedules.json';
$serverLogs = __DIR__.'/logs/server_logs.json';

if(!file_exists($schedulesFile)) { echo json_encode(['error'=>'No schedules file']); exit; }

$schedules = json_decode(file_get_contents($schedulesFile), true) ?: [];

$now = date('H:i');

foreach($schedules as $idx => $job){
    if($job['time'] !== $now) continue;

    foreach($job['recipients'] as $to){
        $body = $job['message'] ?? ' ';
        $base64 = $job['fileMeta']['base64'] ?? '';
        $filename = $job['fileMeta']['filename'] ?? '';

        $post_data = ['to'=>$to, 'body'=>$body];
        $url = "https://api.ultramsg.com/$instance_id/messages/chat?token=$token";

        if($base64 && $filename){
            $url = "https://api.ultramsg.com/$instance_id/messages/document?token=$token";
            $post_data['document'] = $base64;
            $post_data['filename'] = $filename;
            $post_data['caption'] = $body;
        }

        $ch = curl_init();
        curl_setopt($ch, CURLOPT_URL, $url);
        curl_setopt($ch, CURLOPT_POST, 1);
        curl_setopt($ch, CURLOPT_POSTFIELDS, http_build_query($post_data));
        curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
        $response = curl_exec($ch);
        $err = curl_error($ch);
        curl_close($ch);

        $logEntry = [
            'time'=>date('Y-m-d H:i:s'),
            'to'=>$to,
            'filename'=>$filename,
            'message'=>$body,
            'response'=>$response,
            'status'=> $err ? 'failed' : 'sent'
        ];

        file_put_contents($serverLogs, json_encode($logEntry).PHP_EOL, FILE_APPEND);
    }

    // Remove executed job
    unset($schedules[$idx]);
}

// Save remaining schedules
file_put_contents($schedulesFile, json_encode(array_values($schedules), JSON_PRETTY_PRINT));

echo json_encode(['success'=>true,'checked'=>count($schedules)]);