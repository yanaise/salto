/*
*                      Copyright 2021 Salto Labs Ltd.
*
* Licensed under the Apache License, Version 2.0 (the "License");
* you may not use this file except in compliance with
* the License.  You may obtain a copy of the License at
*
*     http://www.apache.org/licenses/LICENSE-2.0
*
* Unless required by applicable law or agreed to in writing, software
* distributed under the License is distributed on an "AS IS" BASIS,
* WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
* See the License for the specific language governing permissions and
* limitations under the License.
*/
import {
  Field, Element, isInstanceElement, Value, Values, isReferenceExpression,
  ReferenceExpression, InstanceElement, ElemID, getField,
} from '@salto-io/adapter-api'
import { TransformFunc, transformValues, resolvePath, getParents } from '@salto-io/adapter-utils'
import _ from 'lodash'
import { logger } from '@salto-io/logging'
import { values as lowerDashValues } from '@salto-io/lowerdash'
import { apiName, metadataType, isCustomObject } from '../transformers/transformer'
import { FilterCreator } from '../filter'
import {
  ReferenceSerializationStrategy, ExtendedReferenceTargetDefinition, ReferenceResolverFinder,
  generateReferenceResolverFinder, ReferenceContextStrategyName, FieldReferenceDefinition,
  getLookUpName,
} from '../transformers/reference_mapping'
import {
  WORKFLOW_ACTION_ALERT_METADATA_TYPE, WORKFLOW_FIELD_UPDATE_METADATA_TYPE,
  WORKFLOW_FLOW_ACTION_METADATA_TYPE, WORKFLOW_OUTBOUND_MESSAGE_METADATA_TYPE,
  WORKFLOW_TASK_METADATA_TYPE, CPQ_LOOKUP_OBJECT_NAME, CPQ_RULE_LOOKUP_OBJECT_FIELD,
  QUICK_ACTION_METADATA_TYPE,
} from '../constants'

const log = logger(module)
const { isDefined } = lowerDashValues
type ElemLookupMapping = Record<string, Record<string, Element>>
type ElemIDToElemLookup = Record<string, Element>
type ContextValueMapperFunc = (val: string) => string | undefined
type ContextFunc = ({ instance, elemByElemID, field, fieldPath }: {
  instance: InstanceElement
  elemByElemID: ElemIDToElemLookup
  field: Field
  fieldPath?: ElemID
}) => string | undefined

const noop = (val: string): string => val

/**
 * Use the value of a neighbor field as the context for finding the referenced element.
 *
 * @param contextFieldName    The name of the neighboring field (same level)
 * @param levelsUp            How many levels to go up in the instance's type definition before
 *                            looking for the neighbor.
 * @param contextValueMapper  An additional function to use to convert the value before the lookup
 */
const neighborContextFunc = ({
  contextFieldName,
  levelsUp = 0,
  contextValueMapper = noop,
}: {
  contextFieldName: string
  levelsUp?: number
  contextValueMapper?: ContextValueMapperFunc
}): ContextFunc => (({ instance, elemByElemID, fieldPath }) => {
  if (fieldPath === undefined || contextFieldName === undefined) {
    return undefined
  }

  const resolveReference = (context: ReferenceExpression, path?: ElemID): string | undefined => {
    const contextField = getField(instance.type, fieldPath.createTopLevelParentID().path)
    const refWithValue = new ReferenceExpression(
      context.elemId,
      context.value ?? elemByElemID[context.elemId.getFullName()],
    )
    return getLookUpName({ ref: refWithValue, field: contextField, path })
  }

  const getParent = (currentFieldPath: ElemID, numLevels = 0): ElemID => {
    const getParentPath = (p: ElemID): ElemID => {
      const isNum = (str: string | undefined): boolean => (
        !_.isEmpty(str) && !Number.isNaN(_.toNumber(str))
      )
      let path = p
      // ignore array indices
      while (isNum(path.getFullNameParts().pop())) {
        path = path.createParentID()
      }
      return path.createParentID()
    }
    if (numLevels <= 0) {
      return getParentPath(currentFieldPath)
    }
    return getParent(getParentPath(currentFieldPath), numLevels - 1)
  }

  const contextPath = getParent(fieldPath, levelsUp).createNestedID(contextFieldName)
  const context = resolvePath(instance, contextPath)
  const contextStr = isReferenceExpression(context)
    ? resolveReference(context, contextPath)
    : context
  return contextValueMapper ? contextValueMapper(contextStr) : contextStr
})

const workflowActionMapper: ContextValueMapperFunc = (val: string) => {
  const typeMapping: Record<string, string> = {
    Alert: WORKFLOW_ACTION_ALERT_METADATA_TYPE,
    FieldUpdate: WORKFLOW_FIELD_UPDATE_METADATA_TYPE,
    FlowAction: WORKFLOW_FLOW_ACTION_METADATA_TYPE,
    OutboundMessage: WORKFLOW_OUTBOUND_MESSAGE_METADATA_TYPE,
    Task: WORKFLOW_TASK_METADATA_TYPE,
  }
  return typeMapping[val]
}

const flowActionCallMapper: ContextValueMapperFunc = (val: string) => {
  const typeMapping: Record<string, string> = {
    apex: 'ApexClass',
    emailAlert: WORKFLOW_ACTION_ALERT_METADATA_TYPE,
    quickAction: QUICK_ACTION_METADATA_TYPE,
  }
  return typeMapping[val]
}

const ContextStrategyLookup: Record<
  ReferenceContextStrategyName, ContextFunc
> = {
  none: () => undefined,
  instanceParent: ({ instance, elemByElemID }) => {
    const parent = getParents(instance)[0]
    return (isReferenceExpression(parent)
      ? apiName(elemByElemID[parent.elemId.getFullName()])
      : undefined)
  },
  neighborTypeLookup: neighborContextFunc({ contextFieldName: 'type' }),
  neighborTypeWorkflow: neighborContextFunc({ contextFieldName: 'type', contextValueMapper: workflowActionMapper }),
  neighborActionTypeFlowLookup: neighborContextFunc({ contextFieldName: 'actionType', contextValueMapper: flowActionCallMapper }),
  neighborActionTypeLookup: neighborContextFunc({ contextFieldName: 'actionType' }),
  neighborCPQLookup: neighborContextFunc({ contextFieldName: CPQ_LOOKUP_OBJECT_NAME }),
  neighborCPQRuleLookup: neighborContextFunc({ contextFieldName: CPQ_RULE_LOOKUP_OBJECT_FIELD }),
  neighborLookupValueTypeLookup: neighborContextFunc({ contextFieldName: 'lookupValueType' }),
  neighborObjectLookup: neighborContextFunc({ contextFieldName: 'object' }),
  parentObjectLookup: neighborContextFunc({ contextFieldName: 'object', levelsUp: 1 }),
  parentInputObjectLookup: neighborContextFunc({ contextFieldName: 'inputObject', levelsUp: 1 }),
  parentOutputObjectLookup: neighborContextFunc({ contextFieldName: 'outputObject', levelsUp: 1 }),
  neighborPicklistObjectLookup: neighborContextFunc({ contextFieldName: 'picklistObject' }),
}

const replaceReferenceValues = (
  instance: InstanceElement,
  resolverFinder: ReferenceResolverFinder,
  elemLookupMap: ElemLookupMapping,
  fieldsWithResolvedReferences: Set<string>,
  elemByElemID: ElemIDToElemLookup,
): Values => {
  const getRefElem = (
    val: string, target: ExtendedReferenceTargetDefinition, field: Field, path?: ElemID
  ): Element | undefined => {
    const findElem = (value: string, targetType?: string): Element | undefined => (
      targetType !== undefined ? elemLookupMap[targetType]?.[value] : undefined
    )

    const parentContextFunc = ContextStrategyLookup[target.parentContext ?? 'none']
    const typeContextFunc = ContextStrategyLookup[target.typeContext ?? 'none']
    if (parentContextFunc === undefined || typeContextFunc === undefined) {
      return undefined
    }
    const elemParent = target.parent ?? parentContextFunc(
      { instance, elemByElemID, field, fieldPath: path }
    )
    const elemType = target.type ?? typeContextFunc({
      instance, elemByElemID, field, fieldPath: path,
    })
    return findElem(
      target.lookup(val, elemParent),
      elemType,
    )
  }

  const replacePrimitive = (val: string, field: Field, path?: ElemID): Value => {
    const toValidatedReference = (
      serializer: ReferenceSerializationStrategy,
      elem: Element | undefined,
    ): ReferenceExpression | undefined => {
      if (elem === undefined) {
        return undefined
      }
      const res = (serializer.serialize({
        ref: new ReferenceExpression(elem.elemID, elem),
        field,
      }) === val) ? new ReferenceExpression(elem.elemID) : undefined
      if (res !== undefined) {
        fieldsWithResolvedReferences.add(field.elemID.getFullName())
      }
      return res
    }

    const reference = resolverFinder(field)
      .filter(refResolver => refResolver.target !== undefined)
      .map(refResolver => toValidatedReference(
        refResolver.serializationStrategy,
        getRefElem(val, refResolver.target as ExtendedReferenceTargetDefinition, field, path),
      ))
      .filter(isDefined)
      .pop()

    return reference ?? val
  }

  const transformPrimitive: TransformFunc = ({ value, field, path }) => (
    (!_.isUndefined(field) && _.isString(value)) ? replacePrimitive(value, field, path) : value
  )

  return transformValues(
    {
      values: instance.value,
      type: instance.type,
      transformFunc: transformPrimitive,
      strict: false,
      pathID: instance.elemID,
    }
  ) || instance.value
}

const mapApiNameToElem = (elements: Element[]): Record<string, Element> => (
  _(elements)
    .map(e => [apiName(e), e])
    .fromPairs()
    .value()
)

const toObjectsAndFields = (elements: Element[]): Element[] => (
  elements.flatMap(e => (isCustomObject(e) ? [e, ...Object.values(e.fields)] : [e]))
)

const groupByMetadataTypeAndApiName = (elements: Element[]): ElemLookupMapping => (
  _(toObjectsAndFields(elements))
    .groupBy(metadataType)
    .mapValues(mapApiNameToElem)
    .value()
)

const mapElemIdToElem = (elements: Element[]): ElemIDToElemLookup => (
  Object.fromEntries(toObjectsAndFields(elements)
    .map(e => [e.elemID.getFullName(), e]))
)

export const addReferences = (
  elements: Element[],
  defs?: FieldReferenceDefinition[]
): void => {
  const resolverFinder = generateReferenceResolverFinder(defs)
  const elemLookup = groupByMetadataTypeAndApiName(elements)
  const fieldsWithResolvedReferences = new Set<string>()
  const elemByElemID = mapElemIdToElem(elements)
  elements.filter(isInstanceElement).forEach(instance => {
    instance.value = replaceReferenceValues(
      instance,
      resolverFinder,
      elemLookup,
      fieldsWithResolvedReferences,
      elemByElemID,
    )
  })
  log.debug('added references in the following fields: %s', [...fieldsWithResolvedReferences])
}

/**
 * Convert field values into references, based on predefined rules.
 *
 */
const filter: FilterCreator = () => ({
  onFetch: async (elements: Element[]) => {
    addReferences(elements)
  },
})

export default filter
