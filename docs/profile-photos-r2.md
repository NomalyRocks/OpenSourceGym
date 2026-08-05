# R2 profile photo setup

Member profile photos are stored in Cloudflare R2 and read through a public
custom domain. Clients do not upload directly to R2; the API validates and
normalizes the image before writing it to the bucket.

## Cloudflare configuration

1. Create an R2 bucket for profile photos.
2. Generate an R2 API token with object read/write permission for this bucket only.
3. Attach a custom domain managed in Cloudflare to the bucket.
4. Keep the public `r2.dev` address disabled in production. Bucket listing is
   not public; only someone who knows the full object URL can read the image.
5. Define the following environment variables for the API:

   - `R2_ACCOUNT_ID`
   - `R2_ACCESS_KEY_ID`
   - `R2_SECRET_ACCESS_KEY`
   - `R2_BUCKET_NAME`
   - `R2_PUBLIC_BASE_URL` (e.g. `https://media.example.com`)

If any of these values is missing in production, the API fails fast and does
not start. In development, the API runs; the profile photo endpoints report
the missing configuration with a `503` response.

## Storage and cache behavior

- The object key is generated randomly on the first upload, and subsequent
  changes overwrite the same key.
- The update time is added to the response URL as a version parameter.
- The R2 object is written with `Cache-Control: public, max-age=300`. An old
  image that was changed or removed may remain in the CDN cache for up to five minutes.
- Account deletion does not complete until the R2 object is deleted.

Because the API uses the server-side S3 endpoint, the bucket does not require a
client upload CORS rule or presigned PUT configuration.
