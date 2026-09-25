import * as https from 'https';
import * as url from 'url';
import { WriteStream } from 'fs';


import { Cache, CacheItem } from '../cache';
import { GitignoreProvider, GitignoreTemplate} from '../interfaces';
import { getAgent } from '../http-client';
import { GithubSession } from '../github/session';
import { GitHubClient } from '../github/client';

/**
 * Github gitignore template provider based on the "/gitignore/templates" endpoint of the Github REST API.
 * https://docs.github.com/en/rest/gitignore
 *
 * Supports a configurable API base URL for GitHub Enterprise compatibility.
 */
export class GithubGitignoreApiProvider implements GitignoreProvider {
	private client: GitHubClient;
	private apiBaseUrl: string;

	constructor(
		private cache: Cache,
		githubSession: GithubSession,
		apiBaseUrl: string = 'https://api.github.com'
	) {
		this.client = new GitHubClient(githubSession);
		this.apiBaseUrl = apiBaseUrl.replace(/\/$/, '');
	}

	/**
	 * Get all .gitignore templates
	 */
	public async getTemplates(): Promise<GitignoreTemplate[]> {
		// If cached, return cached content
		const item = this.cache.get('gitignore') as GitignoreTemplate[];
		if(typeof item !== 'undefined') {
			return item;
		}

		const endpointUrl = `${this.apiBaseUrl}/gitignore/templates`;
		const options: https.RequestOptions = {
			agent: getAgent(),
			method: 'GET',
			headers: {...await this.client.getHeaders(), 'Accept': 'application/vnd.github.v3+json'},
		};

		const responseBody = await this.client.requestString(endpointUrl, options);
		const templatesRaw = JSON.parse(responseBody) as string[];
		const templates = templatesRaw.map(t => <GitignoreTemplate>{ name: t, path: t});

		// Cache the retrieved gitignore files
		this.cache.add(new CacheItem('gitignore', templates));

		return templates;
	}

	public async downloadToStream(templatePath: string, writeStream: WriteStream): Promise<void> {
		const fullUrl = new url.URL(templatePath, `${this.apiBaseUrl}/gitignore/templates/`);
		const options: https.RequestOptions = {
			agent: getAgent(),
			method: 'GET',
			headers: {...await this.client.getHeaders(), 'Accept': 'application/vnd.github.v3.raw'}
		};

		await this.client.requestWriteStream(fullUrl, options, writeStream);
	}
}
