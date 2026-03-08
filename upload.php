<?php
header("Content-Type: application/json");

if (!isset($_FILES["file"])) {
    echo json_encode(["success" => false, "error" => "No file"]);
    exit;
}

$folder = "uploads";
if (!is_dir($folder)) mkdir($folder);

$fname = time() . "_" . basename($_FILES["file"]["name"]);
$path = "$folder/$fname";

if (move_uploaded_file($_FILES["file"]["tmp_name"], $path)) {
    echo json_encode(["success" => true, "url" => $path]);
} else {
    echo json_encode(["success" => false, "error" => "Upload failed"]);
}
?>