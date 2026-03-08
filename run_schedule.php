<?php
header("Content-Type: application/json");
ini_set('display_errors',1);
error_reporting(E_ALL);

define('SCHEDULE_FILE', __DIR__.'/wa_schedules.json');
define('ULTRAMSG_INSTANCE', 'instance153584');
define('ULTRAMSG_TOKEN', 'vman605et11n5ov8');
define('SEND_ENDPOINT', 'https://api.ultramsg.com/'.ULTRAMSG_INSTANCE.'/messages/chat?token='.ULTRAMSG_TOKEN);
define('RATE_DELAY_MS', 1200);

function sendMessage($to, $body, $base64='', $filename='') {
    $post = ['to'=>$to,'body'=>$body];

    // If file provided, determine endpoint
    if($base64 && $filename){
        $tmp = tempnam(sys_get_temp_dir(),'upload_');
        file_put_contents($tmp, base64_decode($base64));
        $mime = mime_content_type($tmp) ?: 'application/octet-stream';

        if(strpos($mime,'image/')===0){
            $url = 'https://api.ultramsg.com/'.ULTRAMSG_INSTANCE.'/messages/image?token='.ULTRAMSG_TOKEN;
            $post = ['to'=>$to,'image'=>new CURLFile($tmp,$mime,$filename),'caption'=>$body];
        } else {
            $url = 'https://api.ultramsg.com/'.ULTRAMSG_INSTANCE.'/messages/document?token='.ULTRAMSG_TOKEN;
            $post = ['to'=>$to,'document'=>new CURLFile($tmp,$mime,$filename),'caption'=>$body];
        }
    } else {
        $url = SEND_ENDPOINT;
    }

    $ch = curl_init();
    curl_setopt($ch, CURLOPT_URL, $url);
    curl_setopt($ch, CURLOPT_POST, true);
    curl_setopt($ch, CURLOPT_POSTFIELDS, $post);
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    $resp = curl_exec($ch);
    $err = curl_error($ch);
    curl_close($ch);

    if(isset($tmp) && file_exists($tmp)) @unlink($tmp);

    return $err?$err:$resp;
}

// Load schedules
$schedules = file_exists(SCHEDULE_FILE)?json_decode(file_get_contents(SCHEDULE_FILE),true):[];

$nowH = (int)date('H');
$nowM = (int)date('i');

$sentList = [];
foreach($schedules as $sched){
    [$h,$m] = explode(':',$sched['time']);
    $h = (int)$h; $m = (int)$m;
    // Check if due
    if($h==$nowH && $m==$nowM){
        foreach($sched['recipients'] as $to){
            $resp = sendMessage($to, $sched['message']??' ', $sched['fileMeta']['base64']??'',$sched['fileMeta']['filename']??'');
            $sentList[] = ['to'=>$to,'time'=>date('Y-m-d H:i'),'response'=>$resp];
            usleep(RATE_DELAY_MS*1000);
        }
    }
}

echo json_encode(['sent'=>$sentList,'count'=>count($sentList)]);