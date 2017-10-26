# Niobium

Instantly publish a static express app to S3 + CloudFront.

## Installation

```sh
npm install --global niobium
```

## Usage

In the same directoy as your express up, simply run niobium and point it to S3 and CloudFront.

```sh
niobium --s3-bucket=www.example.com --cloudfront-distribution-id=UUN6U424UR6JWD
```

## How it works

Niobium starts loads your app with a thin layer between express and the actual app. This is acomplished automatically by hooking into the `require('express')` call in your code, so no code changes should be neccessary.

It then keeps a list of all the routes and static middlewares that added, to get a complete list of all avaialble routes, and starts the app at a random port.

When the app is up and running, niobium simply makes an http request and stores the result in S3. It will also catch any cache-control headers or content-type headers, and send the correct metadata to S3.

Before uploading a file, niobium checks if there currently is a file and if that file is the same (this is done by storing a hash within the metadata of each file). If the file is already in place, the file wont be uploaded.

Lastly, niobium sends an invalidation request for the changed URLs to CloudFront, to make sure that the new content is available immediately.
