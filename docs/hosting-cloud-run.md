# Hosting on Google Cloud Run

```sh
PROJECT=my-project REGION=europe-west4 ./deploy/cloudrun/deploy.sh
```

Needs `gcloud` (logged in) and billing on the project. The script:

1. enables Cloud Run, Artifact Registry, Cloud Build, Secret Manager and Cloud Storage;
2. creates a Cloud Storage bucket (`<project>-brand-portal`) and a service account with access to it;
3. creates secrets for `OBX_SECRET_KEY`, the setup code and an HMAC key for the bucket's S3 API;
4. builds the image with Cloud Build and deploys **one always-on instance** (`--min-instances 1
   --max-instances 1 --no-cpu-throttling`, 1 GiB): SQLite has one writer, and background jobs and the
   minute timer need CPU between requests;
5. stores images in the bucket (S3 API) and replicates the database continuously to the same bucket
   with Litestream; a new container restores it before it starts.

It prints the address and how to read the setup code. Map your own domain with
`gcloud beta run domain-mappings create --service brand-portal --domain brands.yourbrand.com`, then
`gcloud run services update brand-portal --update-env-vars OBX_PUBLIC_URL=https://brands.yourbrand.com`.

**Cost:** you pay for one instance that is always on (1 vCPU, 1 GiB, CPU always allocated) plus
storage; check the [Cloud Run pricing calculator](https://cloud.google.com/products/calculator) for
your region. For less, run the Docker image on a small VM (see [hosting-docker.md](hosting-docker.md))
or use Cloudflare.

**Backups:** Litestream keeps the database replica in the bucket (point-in-time for as long as its
retention, 24 h by default). Turn on Object Versioning on the bucket for the images and the replica
(`gcloud storage buckets update gs://<bucket> --versioning`), and keep `OBX_SECRET_KEY` from Secret
Manager in your password manager. A full copy outside Google Cloud: restore the replica on your
computer with `litestream restore -o obx.sqlite gcs://<bucket>/db` and copy the bucket with
`gcloud storage rsync -r gs://<bucket>/files ./files` (see [operations.md](operations.md#backup-and-restore)).

**Updates:** run the script again; it builds and deploys the current checkout. See [upgrading.md](upgrading.md).

> The script has been checked with shellcheck but has not been run against a real Google Cloud
> project by the maintainers yet.
