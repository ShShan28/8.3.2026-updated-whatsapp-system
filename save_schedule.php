<?php
header('Content-Type: application/json');

if(!is_dir('logs')) mkdir('logs', 0777, true);

$schedulesFile = __DIR__.'/logs/schedules.json';

$input = json_decode(file_get_contents('php://input'), true);
if(!$input || !isset($input['schedules'])) {
    echo json_encode(['error'=>'No schedules received']);
    exit;
}

// Save schedules
file_put_contents($schedulesFile, json_encode($input['schedules'], JSON_PRETTY_PRINT));

echo json_encode(['success'=>true,'count'=>count($input['schedules'])]);