import type { RequestHandler } from 'express';
import { parseOrThrow } from '../validation';
import { createShowBody, showIdParams } from './show.schemas';
import type { ShowService } from './show.service';

/** Thin HTTP layer: validate input, call the service, shape the response. No SQL or business rules here. */
export class ShowController {
  constructor(private readonly service: ShowService) {}

  create: RequestHandler = async (req, res) => {
    const input = parseOrThrow(createShowBody, req.body);
    res.status(201).json(await this.service.createShow(input));
  };

  get: RequestHandler = async (req, res) => {
    const { id } = parseOrThrow(showIdParams, req.params);
    res.status(200).json(await this.service.getShow(id));
  };
}
