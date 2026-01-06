import axios from 'axios';

export default class MonaiLabelClient {
  constructor(server_url, orthancUrl = null) {
    this.server_url = new URL(server_url);
    // Orthanc URL for fetching DICOM data - defaults to local proxy
    this.orthancUrl = orthancUrl || '/pacs';
  }

  /**
   * Lookup Orthanc ID from SeriesInstanceUID
   */
  async lookupSeriesId(seriesInstanceUID) {
    // Remove trailing slash and dicom-web suffix if present, then add tools/lookup
    const baseUrl = this.orthancUrl.replace(/\/dicom-web\/?$/, '').replace(/\/$/, '');
    const url = `${baseUrl}/tools/lookup`;
    console.debug('Looking up series:', seriesInstanceUID, 'at', url);
    try {
      const response = await axios.post(url, seriesInstanceUID, {
        headers: { 'Content-Type': 'text/plain' }
      });
      if (response.data && response.data.length > 0) {
        const seriesResult = response.data.find(item => item.Type === 'Series');
        if (seriesResult) {
          console.debug('Found Orthanc series ID:', seriesResult.ID);
          return seriesResult.ID;
        }
      }
      return null;
    } catch (error) {
      console.error('Failed to lookup series:', error);
      return null;
    }
  }

  /**
   * Download series as ZIP archive from Orthanc
   */
  async downloadSeriesArchive(orthancSeriesId) {
    // Remove trailing slash and dicom-web suffix if present
    const baseUrl = this.orthancUrl.replace(/\/dicom-web\/?$/, '').replace(/\/$/, '');
    const url = `${baseUrl}/series/${orthancSeriesId}/archive`;
    console.debug('Downloading series archive:', url);
    try {
      const response = await axios.get(url, {
        responseType: 'arraybuffer'
      });
      console.debug('Series archive downloaded, size:', response.data.byteLength);
      return new Blob([response.data], { type: 'application/zip' });
    } catch (error) {
      console.error('Failed to download series archive:', error);
      return null;
    }
  }

  /**
   * Fetch DICOM series from Orthanc and return as blob
   */
  async fetchDicomSeries(seriesInstanceUID) {
    // First lookup the Orthanc ID
    const orthancId = await this.lookupSeriesId(seriesInstanceUID);
    if (!orthancId) {
      throw new Error(`Series not found in Orthanc: ${seriesInstanceUID}`);
    }

    // Download the series archive
    const archive = await this.downloadSeriesArchive(orthancId);
    if (!archive) {
      throw new Error(`Failed to download series archive: ${orthancId}`);
    }

    return archive;
  }

  async info() {
    let url = new URL('info/', this.server_url);
    return await MonaiLabelClient.api_get(url.toString());
  }

  async segmentation(model, image, params = {}, label = null) {
    // label is used to send label volumes, e.g. scribbles,
    // that are to be used during segmentation
    return this.infer(model, image, params, label);
  }

  async deepgrow(model, image, foreground, background, params = {}) {
    params['foreground'] = foreground;
    params['background'] = background;
    return this.infer(model, image, params);
  }

  /**
   * Run inference with file upload support.
   * Fetches DICOM from Orthanc and uploads directly to MONAI Label server.
   */
  async infer(model, image, params, label = null, result_extension = '.nii.gz') {
    let url = new URL('infer/' + encodeURIComponent(model), this.server_url);
    url.searchParams.append('output', 'all');
    url = url.toString();

    if (result_extension) {
      params.result_extension = result_extension;
      params.result_dtype = 'uint16';
      params.result_compress = false;
      params.studyInstanceUID = new URLSearchParams(window.location.search).get(
        'StudyInstanceUIDs'
      );
    }

    // return the indexes as defined in the config file
    params.restore_label_idx = false;

    // Fetch DICOM series from Orthanc and upload to MONAI
    console.debug('Fetching DICOM series from Orthanc:', image);
    let dicomBlob;
    try {
      dicomBlob = await this.fetchDicomSeries(image);
      console.debug('DICOM series fetched, size:', dicomBlob.size);
    } catch (error) {
      console.error('Failed to fetch DICOM series:', error);
      // Fall back to old behavior (pass image ID only)
      url = new URL('infer/' + encodeURIComponent(model), this.server_url);
      url.searchParams.append('image', image);
      url.searchParams.append('output', 'all');
      url = url.toString();
      return await MonaiLabelClient.api_post(url, params, label, true, 'arraybuffer');
    }

    // Create FormData with the DICOM file
    const formData = new FormData();
    formData.append('params', JSON.stringify(params));
    formData.append('file', dicomBlob, 'series.zip');

    // Add label if provided (for scribbles, etc.)
    if (label) {
      if (Array.isArray(label)) {
        for (let i = 0; i < label.length; i++) {
          formData.append(label[i].name, label[i].data, label[i].fileName);
        }
      } else {
        formData.append('label', label, 'label.bin');
      }
    }

    console.debug('Uploading DICOM to MONAI Label:', url);
    return await MonaiLabelClient.api_post_data(url, formData, 'arraybuffer');
  }

  async next_sample(stategy = 'random', params = {}) {
    const url = new URL(
      'activelearning/' + encodeURIComponent(stategy),
      this.server_url
    ).toString();

    return await MonaiLabelClient.api_post(url, params, null, false, 'json');
  }

  async save_label(image, label, params) {
    let url = new URL('datastore/label', this.server_url);
    url.searchParams.append('image', image);
    url = url.toString();

    /* debugger; */

    const data = MonaiLabelClient.constructFormDataFromArray(params, label, 'label', 'label.bin');

    return await MonaiLabelClient.api_put_data(url, data, 'json');
  }

  async is_train_running() {
    let url = new URL('train/', this.server_url);
    url.searchParams.append('check_if_running', 'true');
    url = url.toString();

    const response = await MonaiLabelClient.api_get(url);
    return response && response.status === 200 && response.data.status === 'RUNNING';
  }

  async run_train(params) {
    const url = new URL('train/', this.server_url).toString();
    return await MonaiLabelClient.api_post(url, params, null, false, 'json');
  }

  async stop_train() {
    const url = new URL('train/', this.server_url).toString();
    return await MonaiLabelClient.api_delete(url);
  }

  static constructFormDataFromArray(params, data, name, fileName) {
    let formData = new FormData();
    formData.append('params', JSON.stringify(params));
    formData.append(name, data, fileName);
    return formData;
  }

  static constructFormData(params, files) {
    let formData = new FormData();
    formData.append('params', JSON.stringify(params));

    if (files) {
      if (!Array.isArray(files)) {
        files = [files];
      }
      for (let i = 0; i < files.length; i++) {
        formData.append(files[i].name, files[i].data, files[i].fileName);
      }
    }
    return formData;
  }

  static constructFormOrJsonData(params, files) {
    return files ? MonaiLabelClient.constructFormData(params, files) : params;
  }

  static api_get(url) {
    console.debug('GET:: ' + url);
    return axios
      .get(url)
      .then(function (response) {
        console.debug(response);
        return response;
      })
      .catch(function (error) {
        return error;
      })
      .finally(function () {});
  }

  static api_delete(url) {
    console.debug('DELETE:: ' + url);
    return axios
      .delete(url)
      .then(function (response) {
        console.debug(response);
        return response;
      })
      .catch(function (error) {
        return error;
      })
      .finally(function () {});
  }

  static api_post(url, params, files, form = true, responseType = 'arraybuffer') {
    const data = form
      ? MonaiLabelClient.constructFormData(params, files)
      : MonaiLabelClient.constructFormOrJsonData(params, files);
    return MonaiLabelClient.api_post_data(url, data, responseType);
  }

  static api_post_data(url, data, responseType) {
    console.debug('POST:: ' + url);
    return axios
      .post(url, data, {
        responseType: responseType,
        headers: {
          accept: ['application/json', 'multipart/form-data'],
        },
      })
      .then(function (response) {
        console.debug(response);
        return response;
      })
      .catch(function (error) {
        return error;
      })
      .finally(function () {});
  }

  static api_put(url, params, files, form = false, responseType = 'json') {
    const data = form
      ? MonaiLabelClient.constructFormData(params, files)
      : MonaiLabelClient.constructFormOrJsonData(params, files);
    return MonaiLabelClient.api_put_data(url, data, responseType);
  }

  static api_put_data(url, data, responseType = 'json') {
    console.debug('PUT:: ' + url);
    return axios
      .put(url, data, {
        responseType: responseType,
        headers: {
          accept: ['application/json', 'multipart/form-data'],
        },
      })
      .then(function (response) {
        console.debug(response);
        return response;
      })
      .catch(function (error) {
        return error;
      });
  }
}
