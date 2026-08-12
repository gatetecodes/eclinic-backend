ALTER TABLE "HieStructuredAllergy"
  ADD CONSTRAINT "HieStructuredAllergy_visitId_fkey" FOREIGN KEY ("visitId") REFERENCES "Visit"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "HieStructuredAllergy_asserterId_fkey" FOREIGN KEY ("asserterId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "HieStructuredAllergy_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "HieImmunization"
  ADD CONSTRAINT "HieImmunization_visitId_fkey" FOREIGN KEY ("visitId") REFERENCES "Visit"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "HieImmunization_performerId_fkey" FOREIGN KEY ("performerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "HieImmunization_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "HieImagingOrder"
  ADD CONSTRAINT "HieImagingOrder_visitId_fkey" FOREIGN KEY ("visitId") REFERENCES "Visit"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "HieImagingOrder_requesterId_fkey" FOREIGN KEY ("requesterId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "HieImagingOrder_performerId_fkey" FOREIGN KEY ("performerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "HieImagingOrder_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "HieImagingStudy"
  ADD CONSTRAINT "HieImagingStudy_visitId_fkey" FOREIGN KEY ("visitId") REFERENCES "Visit"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "HieImagingStudy_practitionerId_fkey" FOREIGN KEY ("practitionerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "HieImagingStudy_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "HieEmergencyAccess"
  ADD CONSTRAINT "HieEmergencyAccess_clinicianId_fkey" FOREIGN KEY ("clinicianId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "HieEmergencyAccess_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "HieEmergencyAccess_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "HieImagingSeries"
  DROP CONSTRAINT "HieImagingSeries_studyId_fkey",
  ADD CONSTRAINT "HieImagingSeries_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "HieImagingSeries_clinicId_studyId_fkey" FOREIGN KEY ("clinicId", "studyId") REFERENCES "HieImagingStudy"("clinicId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "HieImagingInstance"
  DROP CONSTRAINT "HieImagingInstance_seriesId_fkey",
  ADD CONSTRAINT "HieImagingInstance_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "HieImagingInstance_clinicId_seriesId_fkey" FOREIGN KEY ("clinicId", "seriesId") REFERENCES "HieImagingSeries"("clinicId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
